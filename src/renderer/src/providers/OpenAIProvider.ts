import { getOpenAIWebSearchParams, isSupportedModel, isVisionModel } from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getAssistantSettings, getDefaultModel, getTopNamingModel } from '@renderer/services/AssistantService'
import { EVENT_NAMES } from '@renderer/services/EventService'
import { filterContextMessages } from '@renderer/services/MessagesService'
import { Assistant, FileTypes, GenerateImageParams, Message, Model, Provider, Suggestion } from '@renderer/types'
import { removeSpecialCharacters } from '@renderer/utils'
import { takeRight } from 'lodash'
import OpenAI, { AzureOpenAI } from 'openai'
import {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam
} from 'openai/resources'

import { CompletionsParams } from '.'
import BaseProvider from './BaseProvider'

export default class OpenAIProvider extends BaseProvider {
  private sdk: OpenAI

  constructor(provider: Provider) {
    super(provider)

    if (provider.id === 'azure-openai') {
      this.sdk = new AzureOpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: this.apiKey,
        apiVersion: provider.apiVersion,
        endpoint: provider.apiHost
      })
      return
    }

    this.sdk = new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: this.apiKey,
      baseURL: this.getBaseURL(),
      defaultHeaders: this.defaultHeaders()
    })
  }

  private get isNotSupportFiles() {
    const providers = ['deepseek', 'baichuan', 'minimax']
    return providers.includes(this.provider.id)
  }

  private async getMessageParam(
    message: Message,
    model: Model
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    const isVision = isVisionModel(model)
    const content = await this.getMessageContent(message)

    if (!message.files) {
      return {
        role: message.role,
        content
      }
    }

    if (this.isNotSupportFiles) {
      if (message.files) {
        const textFiles = message.files.filter((file) => [FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type))

        if (textFiles.length > 0) {
          let text = ''
          const divider = '\n\n---\n\n'

          for (const file of textFiles) {
            const fileContent = (await window.api.file.read(file.id + file.ext)).trim()
            const fileNameRow = 'file: ' + file.origin_name + '\n\n'
            text = text + fileNameRow + fileContent + divider
          }

          return {
            role: message.role,
            content: content + divider + text
          }
        }
      }

      return {
        role: message.role,
        content
      }
    }

    const parts: ChatCompletionContentPart[] = [
      {
        type: 'text',
        text: content
      }
    ]

    for (const file of message.files || []) {
      if (file.type === FileTypes.IMAGE && isVision) {
        const image = await window.api.file.base64Image(file.id + file.ext)
        parts.push({
          type: 'image_url',
          image_url: { url: image.data }
        })
      }
      if ([FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type)) {
        const fileContent = await (await window.api.file.read(file.id + file.ext)).trim()
        parts.push({
          type: 'text',
          text: file.origin_name + '\n' + fileContent
        })
      }
    }

    return {
      role: message.role,
      content: parts
    } as ChatCompletionMessageParam
  }

  private getTemperature(assistant: Assistant, model: Model) {
    if (model.id.startsWith('o1') || model.id.startsWith('o3')) {
      return undefined
    }

    if (model.provider === 'deepseek' && model.id === 'deepseek-reasoner') {
      return undefined
    }

    return assistant?.settings?.temperature
  }

  async completions({ messages, assistant, onChunk, onFilterMessages }: CompletionsParams): Promise<void> {
    const defaultModel = getDefaultModel()
    const model = assistant.model || defaultModel
    const { contextCount, maxTokens, streamOutput } = getAssistantSettings(assistant)

    const systemMessage = assistant.prompt ? { role: 'system', content: assistant.prompt } : undefined
    const userMessages: ChatCompletionMessageParam[] = []

    const _messages = filterContextMessages(takeRight(messages, contextCount + 1))
    onFilterMessages(_messages)

    if (model.id === 'deepseek-reasoner') {
      if (_messages[0]?.role !== 'user') {
        userMessages.push({ role: 'user', content: '' })
      }
    }

    for (const message of _messages) {
      userMessages.push(await this.getMessageParam(message, model))
    }

    const isOpenAIo1 = model.id.startsWith('o1')

    const isSupportStreamOutput = () => {
      if (this.provider.id === 'github' && isOpenAIo1) {
        return false
      }
      return streamOutput
    }

    let time_first_token_millsec = 0
    let time_first_content_millsec = 0
    const start_time_millsec = new Date().getTime()

    // @ts-ignore key is not typed
    const stream = await this.sdk.chat.completions.create({
      model: model.id,
      messages: [isOpenAIo1 ? undefined : systemMessage, ...userMessages].filter(
        Boolean
      ) as ChatCompletionMessageParam[],
      temperature: this.getTemperature(assistant, model),
      top_p: assistant?.settings?.topP,
      max_tokens: maxTokens,
      keep_alive: this.keepAliveTime,
      stream: isSupportStreamOutput(),
      ...(assistant.enableWebSearch ? getOpenAIWebSearchParams(model) : {}),
      ...this.getCustomParameters(assistant)
    })

    if (!isSupportStreamOutput()) {
      const time_completion_millsec = new Date().getTime() - start_time_millsec
      return onChunk({
        text: stream.choices[0].message?.content || '',
        usage: stream.usage,
        metrics: {
          completion_tokens: stream.usage?.completion_tokens,
          time_completion_millsec,
          time_first_token_millsec: 0
        }
      })
    }

    for await (const chunk of stream) {
      if (window.keyv.get(EVENT_NAMES.CHAT_COMPLETION_PAUSED)) {
        break
      }

      if (time_first_token_millsec == 0) {
        time_first_token_millsec = new Date().getTime() - start_time_millsec
      }

      if (time_first_content_millsec == 0 && chunk.choices[0]?.delta?.content) {
        time_first_content_millsec = new Date().getTime()
      }

      const time_completion_millsec = new Date().getTime() - start_time_millsec
      const time_thinking_millsec = time_first_content_millsec ? time_first_content_millsec - start_time_millsec : 0

      onChunk({
        text: chunk.choices[0]?.delta?.content || '',
        // @ts-ignore key is not typed
        reasoning_content: chunk.choices[0]?.delta?.reasoning_content || '',
        usage: chunk.usage,
        metrics: {
          completion_tokens: chunk.usage?.completion_tokens,
          time_completion_millsec,
          time_first_token_millsec,
          time_thinking_millsec
        }
      })
    }
  }

  async translate(message: Message, assistant: Assistant, onResponse?: (text: string) => void) {
    const defaultModel = getDefaultModel()
    const model = assistant.model || defaultModel
    const messages = [
      { role: 'system', content: assistant.prompt },
      { role: 'user', content: message.content }
    ]

    const isOpenAIo1 = model.id.startsWith('o1')

    const isSupportedStreamOutput = () => {
      if (!onResponse) {
        return false
      }
      if (this.provider.id === 'github' && isOpenAIo1) {
        return false
      }
      return true
    }

    const stream = isSupportedStreamOutput()

    // @ts-ignore key is not typed
    const response = await this.sdk.chat.completions.create({
      model: model.id,
      messages: messages as ChatCompletionMessageParam[],
      stream,
      keep_alive: this.keepAliveTime,
      temperature: assistant?.settings?.temperature
    })

    if (!stream) {
      return response.choices[0].message?.content || ''
    }

    let text = ''

    for await (const chunk of response) {
      text += chunk.choices[0]?.delta?.content || ''
      onResponse?.(text)
    }

    return text
  }

  public async summaries(messages: Message[], assistant: Assistant): Promise<string> {
    const model = getTopNamingModel() || assistant.model || getDefaultModel()

    const userMessages = takeRight(messages, 5)
      .filter((message) => !message.isPreset)
      .map((message) => ({
        role: message.role,
        content: message.content
      }))

    const userMessageContent = userMessages.reduce((prev, curr) => {
      const content = curr.role === 'user' ? `User: ${curr.content}` : `Assistant: ${curr.content}`
      return prev + (prev ? '\n' : '') + content
    }, '')

    const systemMessage = {
      role: 'system',
      content: getStoreSetting('topicNamingPrompt') || i18n.t('prompts.title')
    }

    const userMessage = {
      role: 'user',
      content: userMessageContent
    }

    // @ts-ignore key is not typed
    const response = await this.sdk.chat.completions.create({
      model: model.id,
      messages: [systemMessage, userMessage] as ChatCompletionMessageParam[],
      stream: false,
      keep_alive: this.keepAliveTime,
      max_tokens: 1000
    })

    return removeSpecialCharacters(response.choices[0].message?.content?.substring(0, 50) || '')
  }

  public async generateText({ prompt, content }: { prompt: string; content: string }): Promise<string> {
    const model = getDefaultModel()

    const response = await this.sdk.chat.completions.create({
      model: model.id,
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content }
      ]
    })

    return response.choices[0].message?.content || ''
  }

  async suggestions(messages: Message[], assistant: Assistant): Promise<Suggestion[]> {
    const model = assistant.model

    if (!model) {
      return []
    }

    const response: any = await this.sdk.request({
      method: 'post',
      path: '/advice_questions',
      body: {
        messages: messages.filter((m) => m.role === 'user').map((m) => ({ role: m.role, content: m.content })),
        model: model.id,
        max_tokens: 0,
        temperature: 0,
        n: 0
      }
    })

    return response?.questions?.filter(Boolean)?.map((q: any) => ({ content: q })) || []
  }

  public async check(model: Model): Promise<{ valid: boolean; error: Error | null }> {
    if (!model) {
      return { valid: false, error: new Error('No model found') }
    }

    const body = {
      model: model.id,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      stream: false
    }

    try {
      const response = await this.sdk.chat.completions.create(body as ChatCompletionCreateParamsNonStreaming)

      return {
        valid: Boolean(response?.choices[0].message),
        error: null
      }
    } catch (error: any) {
      return {
        valid: false,
        error
      }
    }
  }

  public async models(): Promise<OpenAI.Models.Model[]> {
    try {
      const response = await this.sdk.models.list()

      if (this.provider.id === 'github') {
        // @ts-ignore key is not typed
        return response.body
          .map((model) => ({
            id: model.name,
            description: model.summary,
            object: 'model',
            owned_by: model.publisher
          }))
          .filter(isSupportedModel)
      }

      if (this.provider.id === 'together') {
        // @ts-ignore key is not typed
        return response?.body
          .map((model: any) => ({
            id: model.id,
            description: model.display_name,
            object: 'model',
            owned_by: model.organization
          }))
          .filter(isSupportedModel)
      }

      const models = response?.data || []

      return models.filter(isSupportedModel)
    } catch (error) {
      return []
    }
  }

  public async generateImage({
    model,
    prompt,
    negativePrompt,
    imageSize,
    batchSize,
    seed,
    numInferenceSteps,
    guidanceScale,
    signal,
    promptEnhancement
  }: GenerateImageParams): Promise<string[]> {
    const response = (await this.sdk.request({
      method: 'post',
      path: '/images/generations',
      signal,
      body: {
        model,
        prompt,
        negative_prompt: negativePrompt,
        image_size: imageSize,
        batch_size: batchSize,
        seed: seed ? parseInt(seed) : undefined,
        num_inference_steps: numInferenceSteps,
        guidance_scale: guidanceScale,
        prompt_enhancement: promptEnhancement
      }
    })) as { data: Array<{ url: string }> }

    return response.data.map((item) => item.url)
  }

  public async getEmbeddingDimensions(model: Model): Promise<number> {
    const data = await this.sdk.embeddings.create({
      model: model.id,
      input: 'hi'
    })
    return data.data[0].embedding.length
  }
}

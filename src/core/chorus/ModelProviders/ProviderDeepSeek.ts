import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import { StreamResponseParams } from "../Models";
import { IProvider } from "./IProvider";
import { canProceedWithProvider } from "@core/utilities/ProxyUtils";
import OpenAICompletionsAPIUtils from "@core/chorus/OpenAICompletionsAPIUtils";

export class ProviderDeepSeek implements IProvider {
    async streamResponse({
        modelConfig,
        llmConversation,
        apiKeys,
        onChunk,
        onComplete,
        onError,
        additionalHeaders,
        tools,
        customBaseUrl,
    }: StreamResponseParams) {
        const modelName = modelConfig.modelId.split("::")[1];

        const { canProceed, reason } = canProceedWithProvider(
            "deepseek",
            apiKeys,
        );

        if (!canProceed) {
            throw new Error(
                reason || "Please add your DeepSeek API key in Settings.",
            );
        }

        const baseURL = customBaseUrl || "https://api.deepseek.com";

        const isReasoningModel = modelName === "deepseek-reasoner";

        const imageSupport = false;
        const functionSupport = true;

        let messages: OpenAI.ChatCompletionMessageParam[] =
            await OpenAICompletionsAPIUtils.convertConversation(
                llmConversation,
                {
                    imageSupport,
                    functionSupport,
                },
            );

        if (modelConfig.systemPrompt) {
            messages = [
                {
                    role: "system",
                    content: modelConfig.systemPrompt,
                },
                ...messages,
            ];
        }

        const streamParams: OpenAI.ChatCompletionCreateParamsStreaming = {
            model: modelName,
            messages,
            stream: true,
        };

        if (tools && tools.length > 0) {
            streamParams.tools =
                OpenAICompletionsAPIUtils.convertToolDefinitions(tools);
            streamParams.tool_choice = "auto";
        }

        const chunks: OpenAI.ChatCompletionChunk[] = [];

        try {
            const response = await fetch(`${baseURL}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKeys.deepseek}`,
                    "Content-Type": "application/json",
                    ...(additionalHeaders ?? {}),
                },
                body: JSON.stringify(streamParams),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(
                    `DeepSeek API error: HTTP ${response.status} ${response.statusText} - ${text}`,
                );
            }

            if (!response.body) {
                const text = await response.text();
                throw new Error(
                    `DeepSeek API error: missing response body for streaming request - ${text}`,
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let hasStartedThinking = false;
            let hasEndedThinking = false;

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    const lines = part
                        .split("\n")
                        .map((l) => l.trim())
                        .filter(Boolean);

                    for (const line of lines) {
                        if (!line.startsWith("data:")) {
                            continue;
                        }

                        const data = line.slice("data:".length).trim();
                        if (data === "[DONE]") {
                            break;
                        }

                        let parsed:
                            | (OpenAI.ChatCompletionChunk & {
                                  choices: Array<{
                                      delta: {
                                          reasoning_content?: string;
                                          content?: string | null;
                                          tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[];
                                      };
                                  }>;
                              })
                            | undefined;
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            continue;
                        }

                        chunks.push(parsed as OpenAI.ChatCompletionChunk);

                        const delta = parsed?.choices?.[0]?.delta;

                        if (isReasoningModel && delta?.reasoning_content) {
                            if (!hasStartedThinking) {
                                onChunk("<thinking>\n");
                                hasStartedThinking = true;
                            }
                            onChunk(delta.reasoning_content);
                        }

                        if (delta?.content) {
                            if (
                                isReasoningModel &&
                                hasStartedThinking &&
                                !hasEndedThinking
                            ) {
                                onChunk("\n</thinking>\n\n");
                                hasEndedThinking = true;
                            }
                            onChunk(delta.content);
                        }
                    }
                }
            }

            if (isReasoningModel && hasStartedThinking && !hasEndedThinking) {
                onChunk("\n</thinking>\n\n");
            }

            const toolCalls = OpenAICompletionsAPIUtils.convertToolCalls(
                chunks,
                tools ?? [],
            );

            const lastChunk = chunks[chunks.length - 1];
            const usageData = lastChunk?.usage
                ? {
                      prompt_tokens: lastChunk.usage.prompt_tokens,
                      completion_tokens: lastChunk.usage.completion_tokens,
                      total_tokens: lastChunk.usage.total_tokens,
                  }
                : undefined;

            await onComplete(
                undefined,
                toolCalls.length > 0 ? toolCalls : undefined,
                usageData,
            );
        } catch (error: unknown) {
            console.error("[ProviderDeepSeek] Error:", error);

            if (error instanceof Error) {
                const errorMessage = error.message;

                if (
                    errorMessage.includes("context_length_exceeded") ||
                    errorMessage.includes("maximum context length")
                ) {
                    onError(
                        "The conversation is too long for this model's context window. Please start a new chat or use a model with a larger context window.",
                    );
                    return;
                }

                if (
                    errorMessage.includes("invalid_api_key") ||
                    errorMessage.includes("Unauthorized") ||
                    errorMessage.includes("401")
                ) {
                    onError(
                        "Invalid DeepSeek API key. Please check your API key in Settings.",
                    );
                    return;
                }

                if (errorMessage.includes("rate_limit")) {
                    onError(
                        "Rate limit exceeded. Please wait a moment and try again.",
                    );
                    return;
                }
            }

            throw error;
        }
    }
}

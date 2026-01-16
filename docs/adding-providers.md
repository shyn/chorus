# Adding Custom Providers and Models

This guide explains how to add new AI providers (like OpenAI, Anthropic, DeepSeek) and their models to Chorus.

## Overview

Adding a new provider requires changes across multiple layers:

1. **Type definitions** - TypeScript types for API keys and provider names
2. **Provider implementation** - The actual API client that streams responses
3. **Database registration** - Models stored in SQLite via migrations or dynamic registration
4. **UI integration** - Settings form, model selector, and provider logos

## Step-by-Step Guide

### Step 1: Add Type Definitions

#### 1.1 Add to `ApiKeys` type

**File:** `src/core/chorus/Models.ts`

```typescript
export type ApiKeys = {
    anthropic?: string;
    openai?: string;
    // ... existing providers
    yourprovider?: string;  // Add your provider
};
```

#### 1.2 Add to `ProviderName` type

**File:** `src/core/chorus/Models.ts`

```typescript
export type ProviderName =
    | "anthropic"
    | "openai"
    // ... existing providers
    | "yourprovider";  // Add your provider
```

### Step 2: Create Provider Implementation

**File:** `src/core/chorus/ModelProviders/ProviderYourProvider.ts`

```typescript
import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import { StreamResponseParams } from "../Models";
import { IProvider } from "./IProvider";
import { canProceedWithProvider } from "@core/utilities/ProxyUtils";
import OpenAICompletionsAPIUtils from "@core/chorus/OpenAICompletionsAPIUtils";

export class ProviderYourProvider implements IProvider {
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

        // Check API key
        const { canProceed, reason } = canProceedWithProvider(
            "yourprovider",
            apiKeys,
        );
        if (!canProceed) {
            throw new Error(
                reason || "Please add your API key in Settings.",
            );
        }

        const baseURL = customBaseUrl || "https://api.yourprovider.com/v1";

        // Convert conversation to OpenAI-compatible format
        let messages = await OpenAICompletionsAPIUtils.convertConversation(
            llmConversation,
            {
                imageSupport: false,  // Set based on provider capabilities
                functionSupport: true,
            },
        );

        // Add system prompt if provided
        if (modelConfig.systemPrompt) {
            messages = [
                { role: "system", content: modelConfig.systemPrompt },
                ...messages,
            ];
        }

        // Build request params
        const streamParams: OpenAI.ChatCompletionCreateParamsStreaming = {
            model: modelName,
            messages,
            stream: true,
        };

        // Add tools if provided
        if (tools && tools.length > 0) {
            streamParams.tools =
                OpenAICompletionsAPIUtils.convertToolDefinitions(tools);
            streamParams.tool_choice = "auto";
        }

        const chunks: OpenAI.ChatCompletionChunk[] = [];

        try {
            // Use Tauri's HTTP plugin to avoid CORS issues
            const response = await fetch(`${baseURL}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKeys.yourprovider}`,
                    "Content-Type": "application/json",
                    ...(additionalHeaders ?? {}),
                },
                body: JSON.stringify(streamParams),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(
                    `API error: HTTP ${response.status} - ${text}`,
                );
            }

            // Process SSE stream
            const reader = response.body!.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        if (!line.startsWith("data:")) continue;
                        const data = line.slice("data:".length).trim();
                        if (data === "[DONE]") break;

                        try {
                            const parsed = JSON.parse(data);
                            chunks.push(parsed);
                            const delta = parsed.choices?.[0]?.delta;
                            if (delta?.content) {
                                onChunk(delta.content);
                            }
                        } catch {
                            continue;
                        }
                    }
                }
            }

            // Convert tool calls
            const toolCalls = OpenAICompletionsAPIUtils.convertToolCalls(
                chunks,
                tools ?? [],
            );

            await onComplete(
                undefined,
                toolCalls.length > 0 ? toolCalls : undefined,
            );
        } catch (error) {
            console.error("[ProviderYourProvider] Error:", error);
            throw error;
        }
    }
}
```

### Step 3: Register Provider in Factory

**File:** `src/core/chorus/Models.ts`

```typescript
// Add import at top
import { ProviderYourProvider } from "./ModelProviders/ProviderYourProvider";

// Add case in getProvider function
function getProvider(providerName: string): IProvider {
    switch (providerName) {
        // ... existing cases
        case "yourprovider":
            return new ProviderYourProvider();
        default:
            throw new Error(`Unknown provider: ${providerName}`);
    }
}
```

### Step 4: Add to ProxyUtils

**File:** `src/core/utilities/ProxyUtils.ts`

```typescript
const PROVIDER_TO_API_KEY: Record<string, keyof ApiKeys> = {
    // ... existing providers
    yourprovider: "yourprovider",
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    // ... existing providers
    yourprovider: "Your Provider Name",
};
```

### Step 5: Add Context Limit Pattern

**File:** `src/core/chorus/Models.ts`

```typescript
const CONTEXT_LIMIT_PATTERNS: Record<ProviderName, string> = {
    // ... existing providers
    yourprovider: "context_length_exceeded",  // Match your provider's error message
};
```

### Step 6: Add Models

#### Option A: Static Models (Recommended for providers with fixed model lists)

**File:** `src/core/chorus/Models.ts`

```typescript
export async function registerYourProviderModels(db: Database): Promise<number> {
    const models = [
        { id: "yourprovider::model-1", displayName: "Model 1" },
        { id: "yourprovider::model-2", displayName: "Model 2" },
    ];

    await Promise.all(
        models.map((model) =>
            saveModelAndDefaultConfig(
                db,
                {
                    id: model.id,
                    displayName: model.displayName,
                    supportedAttachmentTypes: ["text", "webpage"],
                    isEnabled: true,
                    isInternal: false,
                },
                model.displayName,
                undefined,
                { preserveIsEnabled: true },
            ),
        ),
    );

    return models.length;
}
```

**File:** `src/core/chorus/api/ModelsAPI.ts`

```typescript
// Add module-level variable
let yourProviderDownloadPromise: Promise<number> | null = null;

// In fetchModelConfigs(), add:
if (!yourProviderDownloadPromise) {
    yourProviderDownloadPromise = Models.registerYourProviderModels(db);
    await yourProviderDownloadPromise;
}
```

#### Option B: Dynamic Models (For providers with API-fetched model lists)

See `downloadKimiModels()` in `Models.ts` for an example of fetching models from an API.

#### Option C: Database Migration (For initial model seeding)

**File:** `src-tauri/src/migrations.rs`

```rust
Migration {
    version: 141,  // Use next available version number
    description: "add YourProvider models",
    kind: MigrationKind::Up,
    sql: r#"
        INSERT OR REPLACE INTO models (id, display_name, is_enabled, supported_attachment_types) VALUES
            ('yourprovider::model-1', 'Model 1', 1, '["text", "webpage"]');

        INSERT OR REPLACE INTO model_configs (author, id, model_id, display_name, system_prompt, is_default) VALUES
            ('system', 'yourprovider::model-1', 'yourprovider::model-1', 'Model 1', '', 0);
    "#,
},
```

> ⚠️ **Important:** Rust migrations require rebuilding the Tauri app (`npm run tauri:dev`).

### Step 7: Add to Settings UI

**File:** `src/ui/components/ApiKeysForm.tsx`

```typescript
// Add to providers array
{
    id: "yourprovider",
    name: "Your Provider Name",
    placeholder: "sk-...",
    url: "https://yourprovider.com/api-keys",
},

// Add to PROVIDERS_WITH_MODEL_SETTINGS if applicable
const PROVIDERS_WITH_MODEL_SETTINGS = [
    // ... existing providers
    "yourprovider",
];
```

### Step 8: Add Provider Logo

**File:** `src/ui/components/ui/provider-logo.tsx`

```typescript
case "yourprovider":
    return (
        <img
            src="/yourprovider.svg"
            alt="Your Provider"
            className="w-4 h-4"
        />
    );
```

Create the logo file at `public/yourprovider.svg`.

### Step 9: Add to Model Selector UI

**File:** `src/ui/components/ManageModelsBox.tsx`

```typescript
// Add to directProviders array
const directProviders = [
    // ... existing providers
    "yourprovider",
] as const;

// Add ModelGroup in the render section
{modelGroups.directByProvider.yourprovider.length > 0 && (
    <ModelGroup
        heading="Your Provider"
        models={modelGroups.directByProvider.yourprovider}
        checkedModelConfigIds={checkedModelConfigIds}
        mode={mode}
        onToggleModelConfig={handleToggleModelConfig}
        onAddApiKey={handleAddApiKey}
        groupId="yourprovider"
        showCost={showCost}
    />
)}
```

### Step 10: Add Refresh Hook (Optional)

**File:** `src/core/chorus/api/ModelsAPI.ts`

```typescript
export function useRefreshYourProviderModels() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationKey: ["refreshYourProviderModels"] as const,
        mutationFn: async () => {
            await Models.registerYourProviderModels(db);
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries(
                modelConfigQueries.listConfigs(),
            );
        },
    });
}

// Add to useRefreshModels()
export function useRefreshModels() {
    // ... existing hooks
    const refreshYourProvider = useRefreshYourProviderModels();
    return useMutation({
        mutationFn: async () => {
            await Promise.all([
                // ... existing refreshes
                refreshYourProvider.mutateAsync(),
            ]);
        },
    });
}
```

## Pitfalls and Lessons Learned

### 1. Models Not Appearing in Selector

**Problem:** Added provider but models don't show up.

**Causes & Solutions:**
- **Missing from `directProviders` array** - Add your provider to `ManageModelsBox.tsx`'s `directProviders` array. This is the most commonly missed step!
- **Rust migration not applied** - Run `npm run tauri:dev` to rebuild and apply migrations
- **Dynamic registration not triggered** - Ensure `fetchModelConfigs()` calls your registration function

### 2. CORS Errors

**Problem:** Browser blocks API requests.

**Solution:** Use Tauri's HTTP plugin (`import { fetch } from "@tauri-apps/plugin-http"`) instead of browser fetch. This bypasses CORS restrictions.

### 3. Build Succeeds but Types Missing

**Problem:** TypeScript compiles but provider not recognized at runtime.

**Causes:**
- Missing case in `getProvider()` switch statement
- Missing entry in `PROVIDER_TO_API_KEY` mapping
- Provider name mismatch between model ID prefix and switch case

### 4. Provider Logo Not Showing

**Problem:** Unknown provider icon appears.

**Causes:**
- Missing case in `provider-logo.tsx` switch statement (causes TypeScript exhaustiveness error)
- SVG file not in `public/` directory
- Wrong path in `<img src=...>`

### 5. API Key Check Failing

**Problem:** "Please add your API key" error even after setting key.

**Causes:**
- Provider not added to `PROVIDER_TO_API_KEY` in `ProxyUtils.ts`
- Typo in provider name (case-sensitive!)

### 6. Streaming Not Working

**Problem:** Response comes all at once or not at all.

**Causes:**
- SSE parsing incorrect - ensure you handle `data:` prefix and `[DONE]` signal
- Missing `stream: true` in request params
- Response body not being read incrementally

### 7. Tool Calls Not Working

**Problem:** Model doesn't use tools or tool results are lost.

**Solutions:**
- Use `OpenAICompletionsAPIUtils.convertToolDefinitions()` for consistent formatting
- Use `OpenAICompletionsAPIUtils.convertToolCalls()` to parse streamed tool calls
- Check if provider supports `tool_choice: "auto"` vs other values

### 8. Reasoning/Thinking Content

**Problem:** Need to handle reasoning models (like DeepSeek Reasoner, Claude with thinking).

**Solution:** Check for provider-specific fields like `reasoning_content` and wrap in `<thinking>` tags:

```typescript
if (delta?.reasoning_content) {
    if (!hasStartedThinking) {
        onChunk("<thinking>\n");
        hasStartedThinking = true;
    }
    onChunk(delta.reasoning_content);
}
```

## File Checklist

When adding a new provider, ensure you've modified these files:

- [ ] `src/core/chorus/Models.ts` - ApiKeys, ProviderName, getProvider(), CONTEXT_LIMIT_PATTERNS
- [ ] `src/core/chorus/ModelProviders/ProviderXxx.ts` - New provider implementation
- [ ] `src/core/utilities/ProxyUtils.ts` - API key and display name mappings
- [ ] `src/core/chorus/api/ModelsAPI.ts` - Model registration and refresh hooks
- [ ] `src/ui/components/ApiKeysForm.tsx` - Settings UI
- [ ] `src/ui/components/ui/provider-logo.tsx` - Provider logo
- [ ] `src/ui/components/ManageModelsBox.tsx` - directProviders array and ModelGroup
- [ ] `src-tauri/src/migrations.rs` - Database migration (if using static models)
- [ ] `public/xxx.svg` - Provider logo file

## Testing

1. Run `pnpm run build` to verify TypeScript compiles
2. Run `npm run tauri:dev` to test in the app
3. Add API key in Settings
4. Verify models appear in model selector
5. Send a test message and verify streaming works
6. Test tool calling if applicable

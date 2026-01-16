import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { db } from "../DB";
import { CustomToolsetConfig, ToolPermissionType } from "../Toolsets";
import { ToolsetsManager } from "../ToolsetsManager";
import { homeDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";

export const toolsetsKeys = {
    // toolset configs
    toolsetsConfig: () => ["toolset_configs"] as const, // this includes whether the server is enabled or not, plus config parameters
    customToolsetConfigs: () =>
        [...toolsetsKeys.toolsetsConfig(), "custom"] as const,

    // toolsets -- this does depend on the configs, but we have it under a separate key so that we can manage the relationship manually
    toolsets: () => ["toolsets"] as const,
};

async function fetchToolsetsConfig() {
    return (
        await db.select<
            {
                toolset_name: string;
                parameter_id: string;
                parameter_value: string;
            }[]
        >(
            "SELECT toolset_name, parameter_id, parameter_value FROM toolsets_config",
        )
    ).reduce(
        (acc, c) => {
            acc[c.toolset_name] = {
                ...acc[c.toolset_name],
                [c.parameter_id]: c.parameter_value,
            };
            return acc;
        },
        {} as Record<string, Record<string, string>>,
    );
}

export type CustomToolsetConfigDBRow = {
    name: string;
    command: string;
    args: string;
    env: string;
    default_permission?: string;
    updated_at: string;
};

export function readCustomToolset(
    row: CustomToolsetConfigDBRow,
): CustomToolsetConfig {
    return {
        name: row.name,
        command: row.command,
        args: row.args,
        env: row.env,
        defaultPermission:
            (row.default_permission as ToolPermissionType) ?? "ask",
    };
}

export async function fetchCustomToolsetConfigs(): Promise<
    CustomToolsetConfig[]
> {
    return (
        await db.select<CustomToolsetConfigDBRow[]>(
            "SELECT name, command, args, env, default_permission, updated_at FROM custom_toolsets ORDER BY name",
        )
    ).map(readCustomToolset);
}

export function useToolsetsConfig() {
    return useQuery({
        queryKey: toolsetsKeys.toolsetsConfig(),
        queryFn: fetchToolsetsConfig,
    });
}

function useGetToolsetsConfig() {
    const queryClient = useQueryClient();

    return async () => {
        return await queryClient.ensureQueryData({
            queryKey: toolsetsKeys.toolsetsConfig(),
            queryFn: () => fetchToolsetsConfig(),
        });
    };
}

export function useCustomToolsetConfigs() {
    return useQuery({
        queryKey: toolsetsKeys.customToolsetConfigs(),
        queryFn: fetchCustomToolsetConfigs,
    });
}

function useGetCustomToolsetConfigs() {
    const queryClient = useQueryClient();

    return async () => {
        return await queryClient.ensureQueryData({
            queryKey: toolsetsKeys.customToolsetConfigs(),
            queryFn: () => fetchCustomToolsetConfigs(),
        });
    };
}
export function useUpdateCustomToolsetConfig() {
    const queryClient = useQueryClient();
    const getToolsetsConfig = useGetToolsetsConfig();
    const getCustomToolsetConfigs = useGetCustomToolsetConfigs();

    return useMutation({
        mutationKey: ["updateCustomToolsetConfig"] as const,
        mutationFn: async ({ toolset }: { toolset: CustomToolsetConfig }) => {
            await db.execute(
                "INSERT OR REPLACE INTO custom_toolsets (name, command, args, env, default_permission, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    toolset.name,
                    toolset.command,
                    toolset.args,
                    toolset.env,
                    toolset.defaultPermission ?? "ask",
                    new Date().toISOString(),
                ],
            );
        },
        onSuccess: async () => {
            // Invalidate both custom toolsets and general toolsets queries
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsetsConfig(),
            });
            // ask ToolsetManager to refresh
            await ToolsetsManager.instance.refreshToolsets(
                await getToolsetsConfig(),
                await getCustomToolsetConfigs(),
            );
            // invalidate toolsets query
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsets(),
            });
        },
    });
}

export function useDeleteCustomToolsetConfig() {
    const queryClient = useQueryClient();
    const getToolsetsConfig = useGetToolsetsConfig();
    const getCustomToolsetConfigs = useGetCustomToolsetConfigs();

    return useMutation({
        mutationKey: ["deleteCustomToolsetConfig"] as const,
        mutationFn: async (name: string) => {
            // delete name, command, args, env
            await db.execute("DELETE FROM custom_toolsets WHERE name = ?", [
                name,
            ]);
            // delete enabled/disabled parameter
            await db.execute(
                "DELETE FROM toolsets_config WHERE toolset_name = ?",
                [name],
            );
        },
        onSuccess: async () => {
            // Invalidate both custom toolsets and general toolsets queries
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsetsConfig(),
            });
            // ask ToolsetManager to refresh
            await ToolsetsManager.instance.refreshToolsets(
                await getToolsetsConfig(),
                await getCustomToolsetConfigs(),
            );
            // invalidate toolsets query
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsets(),
            });
        },
    });
}

/**
 * Note duplicated logic between this and useGetToolsets
 */
export function useToolsets() {
    const getToolsetsConfig = useGetToolsetsConfig();
    const getCustomToolsetConfigs = useGetCustomToolsetConfigs();

    return useQuery({
        queryKey: toolsetsKeys.toolsets(),
        queryFn: async () => {
            const toolsetsConfig = await getToolsetsConfig();
            const customToolsetConfigs = await getCustomToolsetConfigs();
            // first, refresh the toolsets in ToolsetsManager
            await ToolsetsManager.instance.refreshToolsets(
                toolsetsConfig,
                customToolsetConfigs,
            );

            // now execute query
            return ToolsetsManager.instance.listToolsets();
        },
    });
}

/**
 * Note duplicated logic between this and useToolsets
 */
export function useGetToolsets() {
    const queryClient = useQueryClient();
    const getToolsetsConfig = useGetToolsetsConfig();
    const getCustomToolsetConfigs = useGetCustomToolsetConfigs();

    return () =>
        queryClient.ensureQueryData({
            queryKey: toolsetsKeys.toolsets(),
            queryFn: async () => {
                const toolsetsConfig = await getToolsetsConfig();
                const customToolsetConfigs = await getCustomToolsetConfigs();
                // first, refresh the toolsets in ToolsetsManager
                await ToolsetsManager.instance.refreshToolsets(
                    toolsetsConfig,
                    customToolsetConfigs,
                );

                // now execute query
                return ToolsetsManager.instance.listToolsets();
            },
        });
}

export function useUpdateToolsetsConfig() {
    const queryClient = useQueryClient();
    const getToolsetsConfig = useGetToolsetsConfig();
    const getCustomToolsetConfigs = useGetCustomToolsetConfigs();

    return useMutation({
        mutationKey: ["updateToolsetsConfig"] as const,
        mutationFn: async ({
            toolsetName,
            parameterId,
            value,
        }: {
            toolsetName: string;
            parameterId: string;
            value: string;
        }) => {
            await db.execute(
                "INSERT OR REPLACE INTO toolsets_config (toolset_name, parameter_id, parameter_value) VALUES (?, ?, ?)",
                [toolsetName, parameterId, value],
            );
        },
        onSuccess: async () => {
            // Invalidate both custom toolsets and general toolsets queries
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsetsConfig(),
            });
            // ask ToolsetManager to refresh
            await ToolsetsManager.instance.refreshToolsets(
                await getToolsetsConfig(),
                await getCustomToolsetConfigs(),
            );
            // invalidate toolsets query
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsets(),
            });
        },
    });
}

type ClaudeDesktopMCPServerConfig = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

export function useImportFromClaudeDesktop() {
    const queryClient = useQueryClient();
    const updateCustomToolsetConfig = useUpdateCustomToolsetConfig();

    return useMutation({
        mutationKey: ["importFromClaudeDesktop"] as const,
        mutationFn: async () => {
            // Determine the path to Claude Desktop MCP config based on platform
            const currentPlatform = platform();
            let configPath: string;

            if (currentPlatform === "macos") {
                configPath = await join(
                    await homeDir(),
                    "Library",
                    "Application Support",
                    "claude",
                    "claude_desktop_config.json",
                );
            } else if (currentPlatform === "windows") {
                // On Windows, Claude Desktop config is at %APPDATA%\Claude\claude_desktop_config.json
                // homeDir() returns C:\Users\<username>, APPDATA is C:\Users\<username>\AppData\Roaming
                configPath = await join(
                    await homeDir(),
                    "AppData",
                    "Roaming",
                    "Claude",
                    "claude_desktop_config.json",
                );
            } else {
                throw new Error(
                    `Unsupported platform: ${currentPlatform}. Claude Desktop import is only supported on macOS and Windows.`,
                );
            }

            // Check if the config file exists
            const fileExists = await exists(configPath);
            if (!fileExists) {
                throw new Error(
                    `Claude Desktop configuration file not found at ${configPath}`,
                );
            }

            // Read and parse the config file
            const configText = await readTextFile(configPath);
            const config = JSON.parse(configText) as {
                mcpServers?: Record<string, ClaudeDesktopMCPServerConfig>;
            };

            // Check if the config contains MCP server configurations
            if (!config.mcpServers || typeof config.mcpServers !== "object") {
                throw new Error(
                    `No MCP server configurations found in Claude Desktop config at ${configPath}`,
                );
            }

            const mcpServerConfigs = config.mcpServers;

            // Process each MCP server configuration
            const importedTools = [];
            for (const [serverName, serverConfig] of Object.entries(
                mcpServerConfigs,
            )) {
                if (serverConfig.command) {
                    // Create a custom toolset config from this MCP server
                    const customToolset = {
                        name: serverName,
                        command: serverConfig.command,
                        args: serverConfig.args
                            ? serverConfig.args
                                  .map((arg) => `"${arg}"`)
                                  .join(" ")
                            : "",
                        env: serverConfig.env
                            ? JSON.stringify(serverConfig.env)
                            : "{}",
                    };

                    // Add to database using the existing mutation
                    await updateCustomToolsetConfig.mutateAsync({
                        toolset: customToolset,
                    });
                    importedTools.push(customToolset);
                }
            }

            return { imported: importedTools.length, tools: importedTools };
        },
        onSuccess: async () => {
            // Invalidate queries to refresh the UI
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.customToolsetConfigs(),
            });
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsetsConfig(),
            });
            await queryClient.invalidateQueries({
                queryKey: toolsetsKeys.toolsets(),
            });
        },
    });
}

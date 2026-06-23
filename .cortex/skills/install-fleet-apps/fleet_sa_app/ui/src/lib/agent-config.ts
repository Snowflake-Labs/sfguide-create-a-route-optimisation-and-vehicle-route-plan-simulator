import { readFileSync } from 'fs';
import { join } from 'path';
import { getSnowflakeAuth } from './sf-auth';

export interface AgentConfig {
  mode: 'agent-object' | 'agentless';
  accountUrl: string;
  token: string;
  tokenType: 'OAUTH' | 'PROGRAMMATIC_ACCESS_TOKEN';
  database?: string;
  schema?: string;
  agentName?: string;
  model?: string;
  instructions?: {
    response?: string;
    orchestration?: string;
  };
  tools?: Array<{ tool_spec: Record<string, unknown> }>;
  toolResources?: Record<string, Record<string, unknown>>;
  budget?: { seconds?: number; tokens?: number };
}

function loadToolsConfig(): { tools?: AgentConfig['tools']; toolResources?: AgentConfig['toolResources'] } {
  const configPath = process.env.AGENT_TOOLS_CONFIG;
  if (!configPath) return {};
  try {
    const fullPath = configPath.startsWith('/') ? configPath : join(process.cwd(), configPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const warehouse = process.env.SNOWFLAKE_WAREHOUSE;
    if (warehouse && parsed.toolResources) {
      for (const key of Object.keys(parsed.toolResources)) {
        if (!parsed.toolResources[key].execution_environment) {
          parsed.toolResources[key].execution_environment = {
            type: 'warehouse',
            warehouse,
          };
        }
      }
    }
    return parsed;
  } catch {
    console.warn(`Failed to load tools config from ${configPath}`);
    return {};
  }
}

export function getAgentConfig(): AgentConfig {
  const mode = (process.env.AGENT_MODE || 'agentless') as AgentConfig['mode'];
  const auth = getSnowflakeAuth();
  const accountUrl = auth.baseUrl;
  const token = auth.token;

  if (!accountUrl) throw new Error('Snowflake account URL (SNOWFLAKE_ACCOUNT_URL or SNOWFLAKE_HOST) is required');
  if (!token) throw new Error('Snowflake token (SNOWFLAKE_PAT or SPCS OAuth) is required');

  const base: AgentConfig = { mode, accountUrl, token, tokenType: auth.tokenType };

  if (mode === 'agent-object') {
    return {
      ...base,
      database: process.env.AGENT_DATABASE,
      schema: process.env.AGENT_SCHEMA,
      agentName: process.env.AGENT_NAME,
    };
  }

  const toolsConfig = loadToolsConfig();

  return {
    ...base,
    model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
    instructions: {
      response: process.env.AGENT_RESPONSE_INSTRUCTIONS,
      orchestration: process.env.AGENT_ORCHESTRATION_INSTRUCTIONS,
    },
    tools: toolsConfig.tools,
    toolResources: toolsConfig.toolResources,
    budget: { seconds: 60, tokens: 32000 },
  };
}

export function buildCortexUrl(config: AgentConfig): string {
  const base = config.accountUrl.replace(/\/+$/, '');
  if (config.mode === 'agent-object') {
    return `${base}/api/v2/databases/${config.database}/schemas/${config.schema}/agents/${config.agentName}:run`;
  }
  return `${base}/api/v2/cortex/agent:run`;
}

export function buildCortexRequestBody(
  config: AgentConfig,
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
  threadId?: number,
  parentMessageId?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages,
    stream: true,
  };

  if (threadId !== undefined) {
    body.thread_id = threadId;
    body.parent_message_id = parentMessageId ?? 0;
  }

  if (config.mode === 'agentless') {
    if (config.model) body.models = { orchestration: config.model };
    if (config.instructions) body.instructions = config.instructions;
    if (config.tools) body.tools = config.tools;
    if (config.toolResources) body.tool_resources = config.toolResources;
    if (config.budget) body.orchestration = { budget: config.budget };
  }

  return body;
}

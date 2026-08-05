// LLM access for agent-type bots. Two providers:
//
//   anthropic  — official @anthropic-ai/sdk, default model claude-opus-5
//   openai     — any OpenAI-compatible /chat/completions endpoint (OpenAI,
//                OpenRouter, local llama.cpp, …) via plain fetch
//
// Config comes from env with the agent's prefix, falling back to global
// AGENT_LLM_* vars so several agents can share one credential:
//
//   <P>_LLM_PROVIDER   anthropic | openai   (default: whichever key exists)
//   <P>_LLM_MODEL      model id (defaults: claude-opus-5 / gpt-4o-mini)
//   <P>_LLM_API_KEY    provider API key (or ANTHROPIC_API_KEY / OPENAI_API_KEY)
//   <P>_LLM_BASE_URL   openai only: endpoint base (default https://api.openai.com/v1)
//   <P>_LLM_MAX_TOKENS reply budget (default 1000)
import Anthropic from '@anthropic-ai/sdk';

function pick(prefix, name) {
  return process.env[`${prefix}_LLM_${name}`] ?? process.env[`AGENT_LLM_${name}`];
}

export function llmFromEnv(prefix) {
  const anthropicKey = pick(prefix, 'API_KEY_ANTHROPIC') ?? process.env.ANTHROPIC_API_KEY;
  const openaiKey = pick(prefix, 'API_KEY_OPENAI') ?? process.env.OPENAI_API_KEY;
  const genericKey = pick(prefix, 'API_KEY');
  const provider = pick(prefix, 'PROVIDER')
    ?? (anthropicKey ? 'anthropic' : openaiKey ? 'openai' : null);
  if (!provider) {
    throw new Error(
      `no LLM credentials for ${prefix}: set ${prefix}_LLM_API_KEY + ${prefix}_LLM_PROVIDER, `
      + 'or ANTHROPIC_API_KEY / OPENAI_API_KEY',
    );
  }
  const maxTokens = Number(pick(prefix, 'MAX_TOKENS')) || 1000;

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: genericKey ?? anthropicKey });
    const model = pick(prefix, 'MODEL') ?? 'claude-opus-5';
    return {
      provider,
      model,
      // messages: [{ role: 'user'|'assistant', content: string }]
      async complete({ system, messages }) {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages,
        });
        if (response.stop_reason === 'refusal') return null;
        return response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim() || null;
      },
    };
  }

  if (provider === 'openai') {
    const base = (pick(prefix, 'BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const key = genericKey ?? openaiKey;
    const model = pick(prefix, 'MODEL') ?? 'gpt-4o-mini';
    return {
      provider,
      model,
      async complete({ system, messages }) {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_completion_tokens: maxTokens,
            messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`${base} responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json();
        return body.choices?.[0]?.message?.content?.trim() || null;
      },
    };
  }

  throw new Error(`unknown LLM provider: ${provider}`);
}

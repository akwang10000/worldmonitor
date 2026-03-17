import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  deduplicateHeadlines,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { isProviderAvailable } from '../../../_shared/llm-health';

// ======================================================================
// Reasoning preamble detection
// ======================================================================

export const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
export const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;
export const TRANSLATION_PREAMBLE = /^(?:here(?:'s| is)? (?:the )?translation\b|translation\b(?:\s+to\s+\w+)?[:：-]?|translated (?:text|headline|summary)\b[:：-]?|译文[:：-]?|翻译[:：-]?|以下(?:是)?(?:译文|翻译)[:：-]?)/i;

export function hasReasoningPreamble(text: string): boolean {
  const trimmed = text.trim();
  return TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed);
}

function normalizeTranslationOutput(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(TRANSLATION_PREAMBLE, '').trim();

  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ];

  for (const [open, close] of quotePairs) {
    if (normalized.startsWith(open) && normalized.endsWith(close) && normalized.length > 2) {
      normalized = normalized.slice(open.length, normalized.length - close.length).trim();
      break;
    }
  }

  return normalized;
}

function isLikelyUntranslatedCopy(source: string, translated: string, targetLang: string): boolean {
  if (!source || !translated || targetLang.toLowerCase() === 'en') return false;

  const normalize = (value: string) => value
    .toLowerCase()
    .replace(/[“”"'‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedSource = normalize(source);
  const normalizedTranslated = normalize(translated);
  if (!normalizedSource || normalizedSource !== normalizedTranslated) return false;

  const sourceWordCount = source.trim().split(/\s+/).filter(Boolean).length;
  const asciiLetters = (source.match(/[A-Za-z]/g) ?? []).length;
  const nonAsciiLetters = (source.match(/[^\x00-\x7F]/g) ?? []).length;

  return sourceWordCount >= 4 && asciiLetters >= 12 && nonAsciiLetters === 0;
}

// ======================================================================
// SummarizeArticle: Multi-provider LLM summarization with Redis caching
// Ported from api/_summarize-handler.js
// ======================================================================

export async function summarizeArticle(
  _ctx: ServerContext,
  req: SummarizeArticleRequest,
): Promise<SummarizeArticleResponse> {
  const { provider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;

  // Input sanitization (M-14 fix): limit headline count and length
  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;
  const headlines = (req.headlines || [])
    .slice(0, MAX_HEADLINES)
    .map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '');
  const sanitizedGeoContext = typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '';

  // Provider credential check
  const skipReasons: Record<string, string> = {
    ollama: 'OLLAMA_API_URL not configured',
    groq: 'GROQ_API_KEY not configured',
    openrouter: 'OPENROUTER_API_KEY not configured',
    generic: 'LLM_API_URL / LLM_API_KEY not configured',
  };

  const credentials = getProviderCredentials(provider);
  if (!credentials) {
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: '',
      errorType: '',
      status: 'SUMMARIZE_STATUS_SKIPPED',
      statusDetail: skipReasons[provider] || `Unknown provider: ${provider}`,
    };
  }

  const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

  // Request validation
  if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: false,
      error: 'Headlines array required',
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Headlines array required',
    };
  }

  try {
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang);
    const isTranslateMode = mode === 'translate';
    const maxTokens = isTranslateMode ? 220 : 100;
    const temperature = isTranslateMode ? 0.05 : 0.3;
    const topP = isTranslateMode ? 0.4 : 0.9;

    // Single atomic call — source tracking happens inside cachedFetchJsonWithMeta,
    // eliminating the TOCTOU race between a separate getCachedJson and cachedFetchJson.
    const { data: result, source } = await cachedFetchJsonWithMeta<{ summary: string; model: string; tokens: number }>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        // Health gate inside fetcher — only runs on cache miss
        if (!(await isProviderAvailable(apiUrl))) return null;
        const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 5));
        const { systemPrompt, userPrompt } = buildArticlePrompts(headlines, uniqueHeadlines, {
          mode,
          geoContext: sanitizedGeoContext,
          variant,
          lang,
        });

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature,
            max_tokens: maxTokens,
            top_p: topP,
            ...extraBody,
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[SummarizeArticle:${provider}] API error:`, response.status, errorText);
          throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
        }

        const data = await response.json() as any;
        const tokens = (data.usage?.total_tokens as number) || 0;
        const message = data.choices?.[0]?.message;
        let rawContent = typeof message?.content === 'string' ? message.content.trim() : '';

        rawContent = rawContent
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
          .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
          .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
          .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
          .trim();

        // Strip unterminated thinking blocks (no closing tag)
        rawContent = rawContent
          .replace(/<think>[\s\S]*/gi, '')
          .replace(/<\|thinking\|>[\s\S]*/gi, '')
          .replace(/<reasoning>[\s\S]*/gi, '')
          .replace(/<reflection>[\s\S]*/gi, '')
          .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
          .trim();

        if (isTranslateMode) {
          rawContent = normalizeTranslationOutput(rawContent);
          if (!rawContent) {
            console.warn(`[SummarizeArticle:${provider}] Empty translation after normalization, rejecting`);
            return null;
          }
          if (TRANSLATION_PREAMBLE.test(rawContent)) {
            console.warn(`[SummarizeArticle:${provider}] Translation preamble detected, rejecting`);
            return null;
          }
          if (isLikelyUntranslatedCopy(headlines[0] || '', rawContent, variant)) {
            console.warn(`[SummarizeArticle:${provider}] Translation appears unchanged from source, rejecting`);
            return null;
          }
        }

        if (['brief', 'analysis'].includes(mode) && rawContent.length < 20) {
          console.warn(`[SummarizeArticle:${provider}] Output too short after stripping (${rawContent.length} chars), rejecting`);
          return null;
        }

        if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
          console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
          return null;
        }

        return rawContent ? { summary: rawContent, model, tokens } : null;
      },
    );

    if (result?.summary) {
      const isCached = source === 'cache';
      return {
        summary: result.summary,
        model: result.model || model,
        provider: isCached ? 'cache' : provider,
        tokens: isCached ? 0 : (result.tokens || 0),
        fallback: false,
        error: '',
        errorType: '',
        status: isCached ? 'SUMMARIZE_STATUS_CACHED' : 'SUMMARIZE_STATUS_SUCCESS',
        statusDetail: '',
      };
    }

    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: 'Empty response',
      errorType: '',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Empty response',
    };

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SummarizeArticle:${provider}] Error:`, error.name, error.message);
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: error.message,
      errorType: error.name,
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: `${error.name}: ${error.message}`,
    };
  }
}

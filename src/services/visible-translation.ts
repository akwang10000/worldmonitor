import { getCurrentLanguage } from './i18n';
import { translateText } from './summarization';

const resolvedTranslations = new Map<string, string | null>();
const inflightTranslations = new Map<string, Promise<string | null>>();

export interface VisibleTranslationOptions {
  selector?: string;
  limit?: number;
  targetLang?: string;
  getText?: (element: HTMLElement) => string;
  shouldTranslate?: (element: HTMLElement, targetLang: string) => boolean;
  applyTranslation?: (element: HTMLElement, translated: string, original: string, targetLang: string) => void;
}

const COMMON_VISIBLE_TRANSLATION_SELECTOR = [
  '[data-translate-source]',
  '.item-title',
  '.article-title',
  '.telegram-intel-text',
  '.telegram-follow-btn',
  '.monitor-add-btn',
  '.live-channel-btn',
  '.panel-tab',
  '.tab-label',
  '.news-title',
  '.ticker-item-title',
  '.cb-news-title',
  '.cdp-news-title',
].join(', ');

function getCacheKey(targetLang: string, text: string): string {
  return `${targetLang}::${text.trim()}`;
}

function getSourceText(element: HTMLElement): string {
  return (
    element.dataset.translateSource ||
    element.dataset.originalText ||
    element.textContent ||
    ''
  ).trim();
}

function shouldTranslateElement(element: HTMLElement, targetLang: string): boolean {
  if (element.dataset.sourceLang?.toLowerCase() === targetLang) return false;
  if (element.dataset.translatedLang === targetLang) return false;
  if (element.dataset.translationFailedLang === targetLang) return false;
  if (element.dataset.translatingLang === targetLang) return false;
  return getSourceText(element).length > 0;
}

function truncateTranslatedText(text: string, maxLengthRaw: string | undefined): string {
  const maxLength = Number.parseInt(maxLengthRaw ?? '', 10);
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function applyDefaultTranslation(
  element: HTMLElement,
  translated: string,
  original: string,
  targetLang: string,
): void {
  element.dataset.translateSource = original;
  element.dataset.originalText = original;
  element.dataset.translatedLang = targetLang;
  element.textContent = truncateTranslatedText(translated, element.dataset.translateMaxLength);
}

function applyTranslationPreservingMarkup(
  element: HTMLElement,
  translated: string,
  original: string,
  targetLang: string,
): void {
  element.dataset.translateSource = original;
  element.dataset.originalText = original;
  element.dataset.translatedLang = targetLang;
  element.innerHTML = truncateTranslatedText(translated, element.dataset.translateMaxLength)
    .replace(/\n/g, '<br>');
}

function isElementVisibleInContainer(element: HTMLElement, container: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) return false;

  const overlapsContainer = rect.bottom > containerRect.top &&
    rect.top < containerRect.bottom &&
    rect.right > containerRect.left &&
    rect.left < containerRect.right;

  if (!overlapsContainer) return false;

  return rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth;
}

export async function translateTextCached(
  text: string,
  targetLang = getCurrentLanguage(),
): Promise<string | null> {
  const normalizedText = text.trim();
  if (!normalizedText) return null;
  if (targetLang === 'en') return normalizedText;

  const cacheKey = getCacheKey(targetLang, normalizedText);
  if (resolvedTranslations.has(cacheKey)) {
    return resolvedTranslations.get(cacheKey) ?? null;
  }

  const existingPromise = inflightTranslations.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const translationPromise = (async () => {
    const translated = await translateText(normalizedText, targetLang);
    const normalizedTranslated = translated?.trim() || null;
    resolvedTranslations.set(cacheKey, normalizedTranslated);
    return normalizedTranslated;
  })().finally(() => {
    inflightTranslations.delete(cacheKey);
  });

  inflightTranslations.set(cacheKey, translationPromise);
  return translationPromise;
}

export async function translateVisibleElements(
  container: HTMLElement,
  options: VisibleTranslationOptions = {},
): Promise<void> {
  if (!container.isConnected) return;

  const targetLang = options.targetLang ?? getCurrentLanguage();
  if (targetLang === 'en') return;

  const selector = options.selector ?? '[data-translate-source]';
  const limit = Math.max(1, options.limit ?? 6);
  const getText = options.getText ?? getSourceText;
  const applyTranslation = options.applyTranslation ?? applyDefaultTranslation;
  const shouldTranslate = options.shouldTranslate ?? shouldTranslateElement;

  const elements = Array.from(container.querySelectorAll<HTMLElement>(selector))
    .filter((element) => isElementVisibleInContainer(element, container))
    .filter((element) => shouldTranslate(element, targetLang))
    .slice(0, limit);

  for (const element of elements) {
    const original = getText(element).trim();
    if (!original) continue;

    element.dataset.translateSource = original;
    element.dataset.translatingLang = targetLang;

    try {
      const translated = await translateTextCached(original, targetLang);
      if (!element.isConnected) continue;
      if (translated) {
        applyTranslation(element, translated, original, targetLang);
        delete element.dataset.translationFailedLang;
      } else {
        element.dataset.translationFailedLang = targetLang;
      }
    } finally {
      if (element.isConnected && element.dataset.translatingLang === targetLang) {
        delete element.dataset.translatingLang;
      }
    }
  }
}

export async function translateCommonVisibleElements(
  container: HTMLElement,
  options: VisibleTranslationOptions = {},
): Promise<void> {
  return translateVisibleElements(container, {
    selector: options.selector ?? COMMON_VISIBLE_TRANSLATION_SELECTOR,
    limit: options.limit ?? 16,
    getText: options.getText,
    shouldTranslate: options.shouldTranslate,
    applyTranslation: options.applyTranslation ?? ((element, translated, original, targetLang) => {
      if (element.classList.contains('telegram-intel-text')) {
        applyTranslationPreservingMarkup(element, translated, original, targetLang);
        return;
      }
      applyDefaultTranslation(element, translated, original, targetLang);
    }),
    targetLang: options.targetLang,
  });
}

/**
 * Dependency-free BERT WordPiece tokenizer: the `BertNormalizer` + `BertPreTokenizer` + `WordPiece`
 * pipeline of a Hugging Face `tokenizer.json`, reimplemented so the static embedder needs neither
 * `@huggingface/transformers` nor `@huggingface/tokenizers` at runtime. Only the pieces the
 * supported static models use are implemented; anything else is rejected at load time instead of
 * silently tokenizing differently from the reference implementation.
 */

export type WordPieceTokenizer = {
  /** Token ids without special tokens (`[CLS]`/`[SEP]`), unknown words mapped to `unkId`. */
  encode(text: string): number[];
  readonly unkId: number;
  readonly vocabSize: number;
};

type TokenizerJson = {
  normalizer?: {
    type?: string;
    clean_text?: boolean;
    handle_chinese_chars?: boolean;
    strip_accents?: boolean | null;
    lowercase?: boolean;
  } | null;
  pre_tokenizer?: { type?: string } | null;
  model?: {
    type?: string;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
    vocab?: Record<string, number>;
  };
};

/** Parses a Hugging Face `tokenizer.json` that describes a BERT-style WordPiece tokenizer. */
export function loadWordPieceTokenizer(json: string): WordPieceTokenizer {
  const spec = JSON.parse(json) as TokenizerJson;
  const normalizer = spec.normalizer;
  if (normalizer?.type !== "BertNormalizer") {
    throw new Error(`unsupported tokenizer normalizer: ${JSON.stringify(normalizer?.type)}`);
  }
  if (spec.pre_tokenizer?.type !== "BertPreTokenizer") {
    throw new Error(
      `unsupported tokenizer pre_tokenizer: ${JSON.stringify(spec.pre_tokenizer?.type)}`,
    );
  }
  const model = spec.model;
  if (model?.type !== "WordPiece" || !model.vocab) {
    throw new Error(`unsupported tokenizer model: ${JSON.stringify(model?.type)}`);
  }

  const vocab = new Map<string, number>(Object.entries(model.vocab));
  const unkToken = model.unk_token ?? "[UNK]";
  const unkId = vocab.get(unkToken);
  if (unkId === undefined) throw new Error(`tokenizer vocab has no unk token ${unkToken}`);
  const prefix = model.continuing_subword_prefix ?? "##";
  const maxCharsPerWord = model.max_input_chars_per_word ?? 100;
  const lowercase = normalizer.lowercase ?? true;
  // HF semantics: `strip_accents: null` follows `lowercase`.
  const stripAccents = normalizer.strip_accents ?? lowercase;
  const cleanText = normalizer.clean_text ?? true;
  const chineseChars = normalizer.handle_chinese_chars ?? true;

  // Word -> ids memo. Vault text repeats words heavily, and WordPiece is the hot loop.
  const memo = new Map<string, number[]>();

  const wordPiece = (word: string): number[] => {
    const cached = memo.get(word);
    if (cached) return cached;
    const chars = Array.from(word);
    let ids: number[];
    if (chars.length > maxCharsPerWord) {
      ids = [unkId];
    } else {
      ids = [];
      let start = 0;
      while (start < chars.length) {
        let end = chars.length;
        let found: number | undefined;
        while (start < end) {
          const piece = chars.slice(start, end).join("");
          const id = vocab.get(start > 0 ? prefix + piece : piece);
          if (id !== undefined) {
            found = id;
            break;
          }
          end -= 1;
        }
        if (found === undefined) {
          ids = [unkId];
          break;
        }
        ids.push(found);
        start = end;
      }
    }
    if (memo.size < 200_000) memo.set(word, ids);
    return ids;
  };

  return {
    unkId,
    vocabSize: vocab.size,
    encode(text) {
      const normalized = normalize(text, { cleanText, chineseChars, stripAccents, lowercase });
      const ids: number[] = [];
      for (const word of preTokenize(normalized)) {
        for (const id of wordPiece(word)) ids.push(id);
      }
      return ids;
    },
  };
}

type NormalizeOptions = {
  cleanText: boolean;
  chineseChars: boolean;
  stripAccents: boolean;
  lowercase: boolean;
};

const CONTROL = /\p{C}/u;
const WHITESPACE = /\s/u;
const MARK_NONSPACING = /\p{Mn}/u;
const PUNCTUATION = /\p{P}/u;

/** Same order as the Rust `BertNormalizer`: clean, pad CJK, strip accents, lowercase. */
function normalize(text: string, options: NormalizeOptions): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (options.cleanText) {
      if (code === 0 || code === 0xfffd) continue;
      if (isWhitespace(char)) {
        out += " ";
        continue;
      }
      if (isControl(char)) continue;
    }
    if (options.chineseChars && isChineseChar(code)) {
      out += ` ${char} `;
      continue;
    }
    out += char;
  }
  if (options.stripAccents) {
    let stripped = "";
    for (const char of out.normalize("NFD")) {
      if (!MARK_NONSPACING.test(char)) stripped += char;
    }
    out = stripped;
  }
  return options.lowercase ? out.toLowerCase() : out;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || WHITESPACE.test(char);
}

function isControl(char: string): boolean {
  if (char === "\t" || char === "\n" || char === "\r") return false;
  return CONTROL.test(char);
}

function isChineseChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b920 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

function isBertPunctuation(char: string): boolean {
  const code = char.codePointAt(0) as number;
  const asciiPunct =
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126);
  return asciiPunct || PUNCTUATION.test(char);
}

/** `BertPreTokenizer`: split on whitespace (dropped) and isolate every punctuation character. */
function* preTokenize(text: string): Generator<string> {
  let word = "";
  for (const char of text) {
    if (isWhitespace(char)) {
      if (word) yield word;
      word = "";
    } else if (isBertPunctuation(char)) {
      if (word) yield word;
      word = "";
      yield char;
    } else {
      word += char;
    }
  }
  if (word) yield word;
}

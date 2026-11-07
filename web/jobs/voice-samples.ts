/**
 * Make one Hindi and one English voice sample from every provider that is set
 * up, so Boss can LISTEN before picking one (issue 43-h4-voice-providers).
 *
 * This is the tool for open decision X5 (human ticket H4): "which paid voice
 * provider speaks the revision explanations in Hindi and English". The
 * decision is Boss's, not an agent's, because it spends money per character.
 * The job's whole job is to make the choice easy: real text, both languages,
 * both providers, side by side, with a price next to each file.
 *
 * HOW TO RUN IT, from inside `web/`:
 *
 *   node --import ./jobs/register-alias.mjs jobs/voice-samples.ts
 *
 * With your own words instead of the built-in ones:
 *
 *   node --import ./jobs/register-alias.mjs jobs/voice-samples.ts \
 *     --text-en "..." --text-hi "..."
 *
 * Full steps, including making the two keys: `jobs/voice-samples.README.md`.
 *
 * WHERE THE FILES GO. `web/live-checks/voice-samples/<provider>-<lang>.mp3`.
 * That folder is gitignored except for its `.gitkeep`, because an mp3 of a
 * paid voice call is not a thing to push to a repository.
 *
 * WHAT IT COSTS. Four short calls, one per provider per language, a few
 * hundred characters each. The printed price comes from `jobs/voice-prices.ts`
 * and every rate in there is marked UNVERIFIED on purpose: it is a reason to
 * open the pricing page, not a figure to plan with.
 *
 * NOTHING IS SWITCHED ON BY RUNNING THIS. The app still reads `VOICE_PROVIDER`
 * (`src/lib/ai/speech-provider.ts`), and until Boss sets that variable every
 * student gets today's behaviour: the explanation, and no audio bar.
 *
 * WHAT IT PRINTS. The provider, the language, the characters sent, the
 * estimated price, and the file path. Never a key, and never a response body:
 * both providers throw one fixed short message plus an HTTP status
 * (`src/lib/ai/speech-errors.ts`), and that is all this job can show.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Lang } from '@/lib/i18n';
import type { Speech } from '@/lib/ai/audio';
import {
  ELEVENLABS_ENV_KEYS,
  createElevenLabsSpeech,
  missingElevenLabsEnv,
} from '@/lib/ai/elevenlabs-speech';
import {
  GOOGLE_ENV_KEYS,
  createGoogleSpeech,
  missingGoogleEnv,
} from '@/lib/ai/google-speech';
import {
  VOICE_PRICES,
  countCharacters,
  estimateUsd,
  formatUsd,
  type VoicePriceProvider,
} from './voice-prices';

/**
 * The built-in English sample, 71 words.
 *
 * Written to sound like a real revision explanation and not like a test
 * string: one polity question, the article that answers it, and a line to
 * remember. That matters, because what Boss is judging is how a voice handles
 * "Rajya Sabha", "Article 80" and an exam-room cadence, which "hello world"
 * would never show.
 */
export const SAMPLE_EN =
  'Here is why the Rajya Sabha is called the Council of States. ' +
  'Article 80 of the Constitution gives it members elected by the elected ' +
  'members of each state assembly, so every state speaks through it. ' +
  'It is a permanent house. It is never dissolved, and one third of its ' +
  'members retire every second year. Remember the pair for the exam. ' +
  'Lok Sabha represents the people directly. Rajya Sabha represents the states.';

/**
 * The built-in Hindi sample, 85 words, Devanagari.
 *
 * The same explanation, not a translation exercise: the point is to hear
 * whether the provider reads "अनुच्छेद" and "सेवानिवृत्त" like a teacher or
 * like a machine reading English letters.
 */
export const SAMPLE_HI =
  'राज्य सभा को राज्यों की परिषद क्यों कहा जाता है, यह समझ लीजिए। ' +
  'संविधान का अनुच्छेद 80 कहता है कि इसके सदस्य हर राज्य की विधान सभा के ' +
  'निर्वाचित सदस्यों द्वारा चुने जाते हैं, इसलिए हर राज्य की आवाज़ इसमें पहुँचती है। ' +
  'यह एक स्थायी सदन है। यह कभी भंग नहीं होता, और इसके एक तिहाई सदस्य हर ' +
  'दूसरे वर्ष सेवानिवृत्त होते हैं। परीक्षा के लिए यह जोड़ी याद रखिए। ' +
  'लोक सभा जनता का सीधा प्रतिनिधित्व करती है। राज्य सभा राज्यों का प्रतिनिधित्व करती है।';

/** Where the mp3s land. Gitignored except for `.gitkeep`. */
const OUT_DIR = new URL('../live-checks/voice-samples/', import.meta.url);

type EnvBag = Record<string, string | undefined>;

interface Candidate {
  name: VoicePriceProvider;
  /** Every variable Boss may set for it, for the "nothing is set up" message. */
  envKeys: readonly string[];
  missing(env: EnvBag): string[];
  create(env: EnvBag): Speech;
}

/** The two candidates, in the order they are tried and printed. */
const CANDIDATES: readonly Candidate[] = [
  {
    name: 'elevenlabs',
    envKeys: ELEVENLABS_ENV_KEYS,
    missing: missingElevenLabsEnv,
    create: (env) => createElevenLabsSpeech({ env }),
  },
  {
    name: 'google',
    envKeys: GOOGLE_ENV_KEYS,
    missing: missingGoogleEnv,
    create: (env) => createGoogleSpeech({ env }),
  },
];

export interface SampleTexts {
  en: string;
  hi: string;
}

/**
 * Read `--text-en` and `--text-hi`, falling back to the built-in samples.
 *
 * Both the `--flag value` and the `--flag=value` spellings, because a Hindi
 * string on a Windows command line is easier to paste after an equals sign.
 */
export function readTexts(argv: readonly string[]): SampleTexts {
  const texts: SampleTexts = { en: SAMPLE_EN, hi: SAMPLE_HI };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    for (const [flag, lang] of [
      ['--text-en', 'en'],
      ['--text-hi', 'hi'],
    ] as const) {
      if (arg === flag) {
        const value = argv[i + 1];
        if (typeof value === 'string' && value.trim().length > 0) texts[lang] = value;
        continue;
      }
      if (arg.startsWith(flag + '=')) {
        const value = arg.slice(flag.length + 1);
        if (value.trim().length > 0) texts[lang] = value;
      }
    }
  }

  return texts;
}

export interface SampleJobResult {
  /** 0 when there was nothing to do or everything worked. */
  exitCode: number;
  /** One line per sample made, per skipped provider, or per failure. */
  lines: string[];
  /** How many mp3 files were written. */
  made: number;
}

/** One sample. Returns the line to print. */
async function makeOne(
  candidate: Candidate,
  speech: Speech,
  lang: Lang,
  text: string,
): Promise<{ line: string; ok: boolean }> {
  const characters = countCharacters(text);
  const price = formatUsd(estimateUsd(candidate.name, characters));
  const file = fileURLToPath(new URL(candidate.name + '-' + lang + '.mp3', OUT_DIR));

  try {
    const bytes = await speech.speak(text, lang);
    await writeFile(file, bytes);
    return {
      ok: true,
      line:
        candidate.name +
        ' ' +
        lang +
        ': ' +
        characters +
        ' characters, about ' +
        price +
        ' (UNVERIFIED, check ' +
        VOICE_PRICES[candidate.name].source +
        '), ' +
        bytes.byteLength +
        ' bytes -> ' +
        file,
    };
  } catch (error) {
    // The providers throw a fixed short message plus a status and nothing
    // else, so this cannot print a key or a response body.
    return {
      ok: false,
      line:
        candidate.name +
        ' ' +
        lang +
        ': FAILED after ' +
        characters +
        ' characters: ' +
        (error instanceof Error ? error.message : 'unknown error'),
    };
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: EnvBag = process.env,
): Promise<SampleJobResult> {
  const texts = readTexts(argv);
  const ready = CANDIDATES.filter((c) => c.missing(env).length === 0);

  // Nothing set up: say exactly what to add, and exit 0. This is the normal
  // first run, not a failure, so it must not look like one.
  if (ready.length === 0) {
    const lines = ['No voice provider is set up. Add one of these to web/.env.local:'];
    for (const candidate of CANDIDATES) {
      lines.push(
        '  ' +
          VOICE_PRICES[candidate.name].label +
          ' needs: ' +
          candidate.envKeys.join(', ') +
          ' (missing: ' +
          candidate.missing(env).join(', ') +
          ')',
      );
    }
    lines.push('Then run this again. Steps: jobs/voice-samples.README.md');
    return { exitCode: 0, lines, made: 0 };
  }

  await mkdir(fileURLToPath(OUT_DIR), { recursive: true });

  const lines: string[] = [];
  let made = 0;
  let failed = 0;

  for (const candidate of CANDIDATES) {
    const gaps = candidate.missing(env);
    if (gaps.length > 0) {
      lines.push(candidate.name + ': skipped, not set up (missing: ' + gaps.join(', ') + ')');
      continue;
    }

    const speech = candidate.create(env);
    // One language at a time, never in parallel: a provider that rate limits
    // would answer one of two calls and the sample would be half missing.
    for (const lang of ['en', 'hi'] as const) {
      const result = await makeOne(candidate, speech, lang, texts[lang]);
      lines.push(result.line);
      if (result.ok) made += 1;
      else failed += 1;
    }
  }

  lines.push('Made ' + made + ' of ' + (made + failed) + ' samples. Listen, then set VOICE_PROVIDER.');
  return { exitCode: failed > 0 ? 1 : 0, lines, made };
}

/**
 * Started only when this file is the process entry point, so a test or a tool
 * can import the sample texts without spending money. Same shape as
 * `jobs/ledger-reconcile.ts`.
 */
const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /voice-samples(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isEntryPoint) {
  main()
    .then((result) => {
      for (const line of result.lines) console.log(line);
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        '[voice-samples] could not run:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exitCode = 1;
    });
}

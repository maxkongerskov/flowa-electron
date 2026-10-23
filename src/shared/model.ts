// Speech model identity + decoding options.
//
// Swift Flowa (Flowa/Support/SpeechModelStore.swift, Transcriber.swift) uses
// WhisperKit 0.18.0 with the bundled CoreML model
//   argmaxinc/whisperkit-coreml : openai_whisper-large-v3-v20240930_turbo
// i.e. OpenAI Whisper large-v3-turbo (checkpoint released 2024-09-30,
// HF openai/whisper-large-v3-turbo), float16, *not* the 632MB quantized variant.
//
// CoreML .mlmodelc can't run outside Apple platforms, so Flowa-Electron runs the
// same checkpoint, same float16 precision, converted to ggml for whisper.cpp:
//   ggerganov/whisper.cpp : ggml-large-v3-turbo.bin   (f16, unquantized, ~1.62 GB)

export const swiftModelVariant = 'openai_whisper-large-v3-v20240930_turbo'
export const hfCheckpoint = 'openai/whisper-large-v3-turbo'

export interface GgmlWeights {
  fileName: string
  url: string
  sha1: string
  approxBytes: number
}

/** Default model. SHA-1 from whisper.cpp v1.9.5 models/README.md. */
export const ggmlModel: GgmlWeights = {
  fileName: 'ggml-large-v3-turbo.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  sha1: '4af2b29d7ec73d781377bfd1758ca957a807e941',
  approxBytes: 1_624_555_275
}

/**
 * OpenAI Whisper small, multilingual (not small.en). Same ggml f16 conversion
 * whisper.cpp publishes. SHA-1 from whisper.cpp v1.9.5 models/README.md.
 * 487,601,967 bytes on Hugging Face.
 */
export const ggmlSmall: GgmlWeights = {
  fileName: 'ggml-small.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
  approxBytes: 487_601_967
}

/** Weights for a speech-model id. Anything other than Whisper Small is Turbo. */
export function ggmlWeightsFor(id: string): GgmlWeights {
  return id === 'whisper-small' ? ggmlSmall : ggmlModel
}

/** Pinned whisper.cpp release that the setup script builds. */
export const whisperCppTag = 'v1.9.5'

/**
 * WhisperKit 0.18.0 DecodingOptions() defaults used by Swift Flowa
 * (Transcriber.transcribe only overrides task, language, detectLanguage):
 *   temperature 0.0, temperatureIncrementOnFallback 0.2, temperatureFallbackCount 5,
 *   topK 5 (sampling only), greedy decoding, withoutTimestamps false,
 *   compressionRatioThreshold 2.4, logProbThreshold -1.0, noSpeechThreshold 0.6,
 *   suppressBlank false, chunkingStrategy nil (no VAD chunking).
 * Mapped to whisper.cpp:
 */
export const decoding = {
  temperature: 0.0,
  temperatureInc: 0.2,
  beamSize: 1, // greedy, like WhisperKit
  bestOf: 1, // WhisperKit samples one candidate per fallback
  entropyThreshold: 2.4, // whisper.cpp's analogue of compressionRatioThreshold 2.4
  logprobThreshold: -1.0,
  noSpeechThreshold: 0.6
} as const

/** whisper-server multipart fields for one /inference request. */
export function inferenceFields(language: string | null): Record<string, string> {
  return {
    language: language ?? 'auto',
    detect_language: 'false',
    translate: 'false',
    temperature: String(decoding.temperature),
    temperature_inc: String(decoding.temperatureInc),
    response_format: 'json',
    no_timestamps: 'false',
    suppress_nst: 'false'
  }
}

/** Command-line args for whisper-server (model stays resident like a loaded WhisperKit pipe). */
export function serverArgs(modelPath: string, port: number, threads: number, useGpu = true): string[] {
  const args = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(threads),
    '-bs', String(decoding.beamSize),
    '-bo', String(decoding.bestOf),
    // whisper-server v1.9.5 has no -tp/-tpi flags (it exits on unknown args);
    // temperature + temperature_inc are sent per request in inferenceFields().
    '-et', String(decoding.entropyThreshold),
    '-lpt', String(decoding.logprobThreshold),
    '-nth', String(decoding.noSpeechThreshold),
    '-l', 'auto'
  ]
  // -ng turns off whichever GPU backend this binary was built with
  // (Metal on macOS, CUDA or Vulkan when those were compiled in).
  if (!useGpu) args.push('-ng')
  return args
}

/** Command-line args for the one-shot whisper-cli fallback. */
export function cliArgs(modelPath: string, wavPath: string, outBase: string, language: string | null, threads: number, useGpu = true): string[] {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language ?? 'auto',
    '-t', String(threads),
    '-bs', String(decoding.beamSize),
    '-bo', String(decoding.bestOf),
    '-tp', String(decoding.temperature),
    '-tpi', String(decoding.temperatureInc),
    '-et', String(decoding.entropyThreshold),
    '-lpt', String(decoding.logprobThreshold),
    '-nth', String(decoding.noSpeechThreshold),
    '-np',
    '-otxt',
    '-of', outBase
  ]
  if (!useGpu) args.push('-ng')
  return args
}

/** Clean whisper.cpp text output the way WhisperKit's joined result reads. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(BLANK_AUDIO|MUSIC|Music|NO SPEECH)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

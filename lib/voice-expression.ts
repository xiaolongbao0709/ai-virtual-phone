// Converts {voice:sighs} into ElevenLabs [sighs] without nested brackets.
const marker = /\{voice:\s*([a-zA-Z][a-zA-Z ,'-]{0,100})\}/g;

export function voiceDisplayText(text: string): string {
    return text.replace(marker, "").replace(/\s{2,}/g, " ").trim();
}

export function voiceSpeechText(text: string): string {
    return text.replace(marker, (_whole, direction: string) => `[${direction.trim()}]`).replace(/\s{2,}/g, " ").trim();
}

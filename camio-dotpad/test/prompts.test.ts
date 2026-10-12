/**
 * The Audiom patch carries an English translation for every prompt code and
 * every status the controls can show; keep them in sync with the library.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPTS } from '../src/prompts';

const patch = readFileSync(fileURLToPath(new URL('../audiom/audiom-integration.patch', import.meta.url)), 'utf8');
// The added translation.json lines, as one JSON-ish text.
const added = patch
	.split('diff --git')
	.find((d) => d.includes('public/locales/en/translation.json'))
	?.split('\n')
	.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
	.join('\n') ?? '';

describe('Audiom translations', () => {
	it('every prompt code has its default English text in camio.prompt.*', () => {
		for (const [code, text] of Object.entries(PROMPTS)) {
			const leaf = code.split('.').at(-1) as string;
			expect(added, code).toContain(`"${leaf}": ${JSON.stringify(text)}`);
		}
	});
	it('every phase / tracking value the controls display has a camio.status.* key', () => {
		const keys = ['off', 'starting', 'idle', 'corners', 'autoFind', 'confirm', 'handsOff', 'none', 'tracking', 'occluded', 'static', 'lost', 'fixed'];
		for (const k of keys) expect(added, k).toMatch(new RegExp(`"${k}": "`));
	});
});

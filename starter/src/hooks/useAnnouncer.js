import { useEffect, useRef, useState } from 'react';
import { createAnnouncer } from '../lib/announcer';

/**
 * React wrapper around `lib/announcer.js`: the texts for the page's polite and
 * assertive live regions, and a STABLE `announce(text, {assertive})` to pass
 * down to the DOT Pad bridge and the camera panels.
 *
 * @returns {{ polite: string, assertive: string, announce: (text: string|{text?: string}, opts?: {assertive?: boolean}) => boolean }}
 */
export function useAnnouncer() {
  const [texts, setTexts] = useState({ polite: '', assertive: '' });
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = createAnnouncer({
      onChange: (channel, text) => setTexts((prev) => (prev[channel] === text ? prev : { ...prev, [channel]: text })),
    });
  }
  useEffect(() => () => ref.current?.dispose(), []);
  return { polite: texts.polite, assertive: texts.assertive, announce: ref.current.announce };
}

export default useAnnouncer;

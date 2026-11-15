// Parse text cues only. Subtitle text is always rendered with textContent.
const SubtitleTools = (() => {
  function timestamp(value) {
    if (!/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(value)) return NaN;
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  function plainText(value) {
    return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi, (entity, code) => {
      const named = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'" };
      if (code[0] !== '#') return named[code.toLowerCase()];
      const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    });
  }

  function parse(vtt) {
    const normalized = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!/^WEBVTT(?:[ \t\n]|$)/.test(normalized)) throw new Error('Invalid WebVTT subtitles');
    const cues = [];
    for (const block of normalized.split(/\n[ \t]*\n/).slice(1)) {
      const lines = block.split('\n');
      if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const timing = lines[0].includes('-->') ? 0 : 1;
      const match = (lines[timing] || '').match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) continue;
      const start = timestamp(match[1]);
      const end = timestamp(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        cues.push({ start, end, text: plainText(lines.slice(timing + 1).join('\n').replace(/\n+$/, '')) });
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function textAt(cues, movieTime, delay) {
    const time = movieTime - delay; // Positive delay makes subtitles appear later.
    return cues.filter(cue => cue.start <= time && time < cue.end).map(cue => cue.text).join('\n');
  }

  return { parse, textAt };
})();

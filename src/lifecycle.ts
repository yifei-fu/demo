/** Registration points for things that must happen at Begin (round 2 starts audio here). */

type Handler = () => void;
const tapHandlers: Handler[] = [];
const beginHandlers: Handler[] = [];
const muteHandlers: Array<(muted: boolean) => void> = [];

/** Runs synchronously inside the Begin tap; use for anything that needs the user gesture. */
export const onBeginTap = (h: Handler): void => void tapHandlers.push(h);
/** Runs once sensors are armed and the gate is fading out. */
export const onBegin = (h: Handler): void => void beginHandlers.push(h);
export const onMute = (h: (muted: boolean) => void): void => void muteHandlers.push(h);

export const fireBeginTap = (): void => tapHandlers.forEach((h) => h());
export const fireBegin = (): void => beginHandlers.forEach((h) => h());
export const fireMute = (muted: boolean): void => muteHandlers.forEach((h) => h(muted));

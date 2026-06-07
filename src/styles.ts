import type { ChatWidgetTheme } from './config.js';

/**
 * Render the widget's scoped stylesheet. All theme values are injected as CSS
 * custom properties on `:host` so they can be overridden per-instance and so the
 * styles below stay static. Kept deliberately framework-light — no Tailwind, no
 * runtime CSS-in-JS; just a string the web component drops into its shadow root.
 */
export function buildStyles(theme: Required<ChatWidgetTheme>): string {
    return `
:host {
    --sac-text: ${theme.text};
    --sac-bg: ${theme.background};
    --sac-primary: ${theme.primary};
    --sac-primary-text: ${theme.primaryText};
    --sac-assistant-bubble: ${theme.assistantBubble};
    --sac-assistant-bubble-text: ${theme.assistantBubbleText};
    --sac-user-bubble: ${theme.userBubble};
    --sac-user-bubble-text: ${theme.userBubbleText};
    --sac-border: ${theme.border};

    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

* { box-sizing: border-box; }

.launcher {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    background: var(--sac-primary);
    color: var(--sac-primary-text);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    transition: transform 0.15s ease;
}
.launcher:hover { transform: scale(1.05); }

.panel {
    width: 360px;
    max-width: calc(100vw - 40px);
    height: 520px;
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    background: var(--sac-bg);
    color: var(--sac-text);
    border: 1px solid var(--sac-border);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--sac-primary);
    color: var(--sac-primary-text);
}
.header .title { font-weight: 600; font-size: 15px; }
.header .status { font-size: 11px; opacity: 0.85; }
.header .close {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 4px;
}

.messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.bubble {
    max-width: 80%;
    padding: 9px 12px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
}
.bubble.assistant {
    align-self: flex-start;
    background: var(--sac-assistant-bubble);
    color: var(--sac-assistant-bubble-text);
    border-bottom-left-radius: 4px;
}
.bubble.user {
    align-self: flex-end;
    background: var(--sac-user-bubble);
    color: var(--sac-user-bubble-text);
    border-bottom-right-radius: 4px;
}
.bubble.greeting { opacity: 0.85; font-style: italic; }

.cursor::after {
    content: '▋';
    margin-left: 1px;
    animation: sac-blink 1s steps(2, start) infinite;
}
@keyframes sac-blink { to { visibility: hidden; } }

.composer {
    display: flex;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid var(--sac-border);
}
.composer textarea {
    flex: 1;
    resize: none;
    border: 1px solid var(--sac-border);
    border-radius: 8px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 14px;
    background: transparent;
    color: var(--sac-text);
    max-height: 96px;
    line-height: 1.4;
}
.composer textarea:focus { outline: 1px solid var(--sac-primary); }
.composer button {
    border: none;
    border-radius: 8px;
    padding: 0 14px;
    cursor: pointer;
    background: var(--sac-primary);
    color: var(--sac-primary-text);
    font-weight: 600;
    font-size: 14px;
}
.composer button:disabled { opacity: 0.5; cursor: default; }

.hidden { display: none !important; }
`;
}

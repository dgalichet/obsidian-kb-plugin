import { addIcon } from "obsidian";

export const OBSIDIAN_KB_ICON_ID = "obsidian-kb";

const OBSIDIAN_KB_ICON_SVG = `
<g fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M45 7 17 34l8 48 20 11 20-11 8-48L45 7Z"/>
  <path d="M17 34h56"/>
  <path d="M45 7 33 34l12 59"/>
  <path d="M45 7 57 34 45 93"/>
  <circle cx="68" cy="66" r="15"/>
  <path d="m79 77 13 13"/>
</g>
`;

export function registerObsidianKbIcon(): void {
  addIcon(OBSIDIAN_KB_ICON_ID, OBSIDIAN_KB_ICON_SVG);
}

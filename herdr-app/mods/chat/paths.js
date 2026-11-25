// This computer's herdr-chat state, in the app's home.

import { appHome } from "herdr";

export const stateDir = () => `${appHome()}/data/herdr-chat`;

/** Where the person's settings live (README "Configuration"); install never writes it. */
export const settingsPath = () => `${stateDir()}/settings.json`;

// The product's names, in one place: the core's code takes them from here. (Comments, docs and the channels, which
// import nothing from the core, spell them out.)
export const PRODUCT = "Pi-personal"; // shown to people
export const COMMAND = "pi-personal"; // the command, directory names, terminal names, labels, settings file
export const ENV = COMMAND.toUpperCase().replace(/-/g, "_"); // prefix of environment variables: PI_PERSONAL_HOME, PI_PERSONAL_PORT, ...
export const SETTINGS_FILE = `${COMMAND}.json`; // the settings file in an agent's visible folder

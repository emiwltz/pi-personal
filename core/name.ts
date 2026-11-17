// The product's names, in one place: the core's code takes them from here. (Comments, docs and the channels, which
// import nothing from the core, spell them out.)
export const PRODUCT = "Pi-personal"; // shown to people
export const COMMAND = process.env.PI_PERSONAL_COMMAND || "pp"; // what people type (the installed command says which name it has, pp or pi-personal)
delete process.env.PI_PERSONAL_COMMAND; // read once: not handed on to Herdr Core (its terminals), pi or the channels
export const SLUG = "pi-personal"; // folder names, terminal names, labels, the login service, the settings file
export const ENV = SLUG.toUpperCase().replace(/-/g, "_"); // prefix of environment variables: PI_PERSONAL_HOME, PI_PERSONAL_PORT, ...
export const SETTINGS_FILE = `${SLUG}.json`; // the settings file in an agent's visible folder

import packageJson from "../package.json" with { type: "json" };

/** Single source of truth for the product version: package.json. */
export const productVersion = packageJson.version;
export const productName = "BoxPilot";

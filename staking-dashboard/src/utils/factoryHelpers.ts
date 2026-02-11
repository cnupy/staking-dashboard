import type { Address } from "viem";

/**
 * Map of factory addresses to human-readable names
 * These are network-specific addresses
 */
export const FACTORY_NAMES: Record<string, string> = {
  // Mainnet factories
  "0xaa292e8611adf267e563f334ee42320ac96d0463": "Genesis Sale",
  "0x3155755b79aa083bd953911c92705b7aa82a18f9": "Auction",
  "0xa17ea96757c9bb9b41a12ef5073c51129937ffae": "Employee",
  "0x278f39b11b3de0796561e85cb48535c9f45ddfcc": "Investor",

  // Anvil/Dev factories
  "0xd6e1afe5ca8d00a2efc01b89997abe2de47fdfaf": "Employee",
  "0x6f6f570f45833e249e27022648a26f4076f48f78": "Investor",
};

/**
 * Get human-readable factory name from factory address
 * Falls back to "Unknown" if factory address is not recognized
 */
export function getFactoryName(factoryAddress?: Address | string): string {
  if (!factoryAddress) {
    return "Unknown";
  }

  const normalized = factoryAddress.toLowerCase();
  return FACTORY_NAMES[normalized] || "Unknown";
}

/**
 * Get short factory identifier (first word only)
 * Used for compact displays
 */
export function getFactoryShortName(factoryAddress?: Address | string): string {
  const fullName = getFactoryName(factoryAddress);
  return fullName.split(" ")[0]; // Returns "Genesis", "Auction", "Employee", "Investor", or "Unknown"
}

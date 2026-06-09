import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface ProviderMetadata {
  providerId: number;
  providerName: string;
  providerDescription: string;
  providerEmail: string;
  providerWebsite: string;
  providerLogoUrl: string;
  discordUsername: string;
  providerSelfStake?: string[];
  /**
   * Operators using the `aztec-staking-payout` tool (or any other
   * out-of-protocol payout mechanism) point this at the URL where
   * their distribution audit reports are published — typically a
   * public Git repo. Presence of this field flips the UI from "claim
   * your rewards via the protocol" to an informational notice; the
   * URL is also surfaced as a link so delegators can verify
   * distributions. Operator-self-declared, not platform-verified.
   */
  manualPayoutAuditUrl?: string;
}

/**
 * Validate and normalize provider metadata
 * Only providerId is required, other fields will fallback to empty strings if invalid
 */
export function normalizeProvider(metadata: any, filename: string): ProviderMetadata | null {
  // ProviderId is the only required field
  if (typeof metadata.providerId !== 'number' || metadata.providerId <= 0) {
    console.warn(`⚠️  ${filename}: invalid or missing providerId - skipping`);
    return null;
  }

  const warnings: string[] = [];

  // Validate a URL as syntactically well-formed AND http(s)-scheme
  // AND free of embedded userinfo.
  //
  // 1. Protocol whitelist is the load-bearing security check: every
  //    URL field on a provider eventually lands in an `<a href>`
  //    somewhere in the dashboard, and `new URL(...)` happily parses
  //    `javascript:`, `data:`, `vbscript:`, etc. without complaint.
  //    React does not block scripted-scheme hrefs at render time, so
  //    accepting those would let a malicious operator config execute
  //    arbitrary JS in the dashboard origin.
  // 2. Reject `https://attacker@trusted.com/`-style userinfo too:
  //    legitimate audit-report URLs never have credentials in them,
  //    but a malicious one can use the userinfo trick to make the
  //    displayed text look like a trusted domain while the browser
  //    actually navigates to the userinfo-encoded host. Defense in
  //    depth — modern browsers obscure the userinfo, but not all
  //    have done so consistently.
  //
  // Closes all three vectors at the only ingress point for these
  // fields (`providerWebsite`, `providerLogoUrl`, `manualPayoutAuditUrl`).
  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "http:" || parsed.protocol === "https:")
        && parsed.username === ""
        && parsed.password === "";
    } catch {
      return false;
    }
  };

  // Normalize each field
  const providerName = typeof metadata.providerName === 'string' && metadata.providerName.trim()
    ? metadata.providerName.trim()
    : '';

  const providerDescription = typeof metadata.providerDescription === 'string' && metadata.providerDescription.trim()
    ? metadata.providerDescription.trim()
    : '';

  const providerEmail = typeof metadata.providerEmail === 'string' && metadata.providerEmail.trim()
    ? metadata.providerEmail.trim()
    : '';

  const providerWebsite = typeof metadata.providerWebsite === 'string' && validateUrl(metadata.providerWebsite)
    ? metadata.providerWebsite
    : '';

  const providerLogoUrl = typeof metadata.providerLogoUrl === 'string' && validateUrl(metadata.providerLogoUrl)
    ? metadata.providerLogoUrl
    : '';

  const discordUsername = typeof metadata.discordUsername === 'string' && metadata.discordUsername.trim()
    ? metadata.discordUsername.trim()
    : '';

  // Validate providerSelfStake (optional array of attester addresses)
  const providerSelfStake = Array.isArray(metadata.providerSelfStake) && metadata.providerSelfStake.length > 0
    ? metadata.providerSelfStake.filter((addr: any) => typeof addr === 'string' && addr.trim().length > 0)
    : undefined;

  // Validate manualPayoutAuditUrl (optional URL pointing at where the
  // operator publishes payout audit reports). Drop silently on a
  // malformed URL — better to omit the field than show a broken link.
  const manualPayoutAuditUrl =
    typeof metadata.manualPayoutAuditUrl === 'string' && validateUrl(metadata.manualPayoutAuditUrl)
      ? metadata.manualPayoutAuditUrl
      : undefined;

  // Collect warnings for missing/invalid fields
  if (!providerName) warnings.push('providerName');
  if (!providerDescription) warnings.push('providerDescription');
  if (!providerEmail) warnings.push('providerEmail');
  if (!providerWebsite) warnings.push('providerWebsite');
  if (!providerLogoUrl) warnings.push('providerLogoUrl');
  if (!discordUsername) warnings.push('discordUsername');

  if (warnings.length > 0) {
    console.warn(`⚠️  ${filename}: missing or invalid fields: ${warnings.join(', ')}`);
  }

  const result: ProviderMetadata = {
    providerId: metadata.providerId,
    providerName,
    providerDescription,
    providerEmail,
    providerWebsite,
    providerLogoUrl,
    discordUsername
  };

  // Only add providerSelfStake if it has valid entries
  if (providerSelfStake && providerSelfStake.length > 0) {
    result.providerSelfStake = providerSelfStake;
  }

  if (manualPayoutAuditUrl) {
    result.manualPayoutAuditUrl = manualPayoutAuditUrl;
  }

  return result;
}

/**
 * Aggregate all provider metadata files from a directory into a single JSON file
 */
export function aggregateProvidersFromDir(providersDir: string, outputFile: string) {
  const providerMap = new Map<number, { provider: ProviderMetadata; filename: string }>();
  let skippedCount = 0;
  let duplicateCount = 0;

  try {
    const files = readdirSync(providersDir).sort(); // Sort to ensure consistent ordering

    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('_')) {
        continue;
      }

      try {
        const filePath = join(providersDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const metadata = JSON.parse(content);

        const normalized = normalizeProvider(metadata, file);
        if (!normalized) {
          skippedCount++;
          continue;
        }

        // Check for duplicate provider ID
        if (providerMap.has(normalized.providerId)) {
          const existing = providerMap.get(normalized.providerId)!;
          console.warn(`⚠️  ${file}: duplicate providerId ${normalized.providerId} (keeping ${existing.filename})`);
          duplicateCount++;
          continue;
        }

        providerMap.set(normalized.providerId, { provider: normalized, filename: file });
      } catch (error) {
        console.warn(`⚠️  ${file}: failed to parse JSON - ${error}`);
        skippedCount++;
      }
    }

    // Convert map to array and sort by providerId
    const providers = Array.from(providerMap.values())
      .map(entry => entry.provider)
      .sort((a, b) => a.providerId - b.providerId);

    // Create output directory if it doesn't exist (cross-platform)
    const outputDir = dirname(outputFile);
    mkdirSync(outputDir, { recursive: true });

    // Write aggregated file
    writeFileSync(outputFile, JSON.stringify(providers, null, 2), 'utf-8');

    console.log(`✓ Aggregated ${providers.length} provider metadata file(s) to ${outputFile}`);
    if (duplicateCount > 0) {
      console.log(`⚠️  Skipped ${duplicateCount} duplicate provider ID(s)`);
    }
    if (skippedCount > 0) {
      console.log(`⚠️  Skipped ${skippedCount} invalid file(s)`);
    }
  } catch (error) {
    console.error('❌ Failed to aggregate provider metadata:', error);
    process.exit(1);
  }
}


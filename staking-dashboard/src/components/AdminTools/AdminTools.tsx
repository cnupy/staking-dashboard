import styles from "./AdminTools.module.css";
import { useState, useEffect } from "react";
import {
  useAccount,
  useReadContract,
} from "wagmi";
import {
  useProviderRegisteredEvents,
} from "../../hooks/stakingRegistry";
import { useAtpRegistryData } from "../../hooks";
import { contracts } from "../../contracts";
import { useTransactionCart } from "@/contexts/TransactionCartContext";
import {
  buildRegisterProviderEntry,
  buildAddKeysToProviderEntry,
  type ProviderKeyStore,
} from "@/utils/actionCart";
import type { Address } from "viem";

export default function AdminTools() {
  const { address } = useAccount();
  const { addTransaction, openCart } = useTransactionCart();

  const [selectedProviderId, setSelectedProviderId] = useState<number>(1);

  const { executeAllowedAt } = useAtpRegistryData();

  // Get the owner of ATPRegistry
  const { data: atpRegistryOwner } = useReadContract({
    abi: contracts.atpRegistry.abi,
    address: contracts.atpRegistry.address,
    functionName: "owner",
  });
  const { hasRegisteredProviders, providerCount, events } =
    useProviderRegisteredEvents();

  // Console log the ATPRegistry owner when it changes
  useEffect(() => {
    if (atpRegistryOwner) {
      console.log(
        "ATPRegistry owner (who can call setExecuteAllowedAt):",
        atpRegistryOwner,
      );
    }
  }, [atpRegistryOwner]);

  const isExecuteAllowedAtInPast = executeAllowedAt
    ? Number(executeAllowedAt) < Math.floor(Date.now() / 1000)
    : false;

  const formatProviderIds = () => {
    if (events.length === 0) return "none";
    if (events.length === 1) {
      return events[0].args.providerIdentifier?.toString() || "0";
    }

    const ids = events
      .map((event) => event.args.providerIdentifier?.toString())
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b));

    if (ids.length <= 3) {
      return ids.join(", ");
    }

    return `${ids[0]}...${ids[ids.length - 1]}`;
  };

  const handleRegisterProvider = () => {
    if (!address) {
      console.error("No address is connected thus can't set providerAdmin");
      return;
    }
    addTransaction(
      buildRegisterProviderEntry({ providerAdmin: address }),
      { preventDuplicate: true },
    );
    openCart();
  };

  // Generate fake keystore like in tests
  const makeKeyStore = (attesterAddress: Address): ProviderKeyStore => {
    return {
      attester: attesterAddress,
      publicKeyG1: {
        x: 21406448581391926982772844446548438929012710273723230115554659256913375512252n,
        y: 15111830880134453058842585834712986668147304355363816616888186003950649005068n,
      },
      publicKeyG2: {
        x0: 5143855711807468219645686078782286945336311747067561895997475661437616288545n,
        x1: 18733138756728241474327814838400205112935650107046117231230447788722289371769n,
        y0: 11666545650645167049648773780858545351306991548173957682910562744565641347660n,
        y1: 11666545650645167049648773780858545351306991548173957682910562744565641347660n,
      },
      signature: {
        x: 11658815187946308125889171893697877633198005084429559307373203442945229832414n,
        y: 10173055490169667164917203310334011859136376115031862675136213312147359258359n,
      },
    };
  };

  const handleAddKeysToProvider = () => {
    // Generate a fake attester address based on provider ID
    const fakeAttester =
      `0x${selectedProviderId.toString().padStart(40, "0")}` as `0x${string}`;
    const keyStore = makeKeyStore(fakeAttester);

    addTransaction(
      buildAddKeysToProviderEntry({
        providerId: selectedProviderId,
        keyStores: [keyStore],
      }),
      { preventDuplicate: true },
    );
    openCart();
  };

  return (
    <div className={styles.adminTools}>
      <h3>Admin Tools</h3>

      <div
        className={
          isExecuteAllowedAtInPast
            ? styles.executionAllowed
            : styles.executionNotAllowed
        }
      >
        <span>
          {isExecuteAllowedAtInPast
            ? "Execution allowed"
            : "Execution not allowed"}
        </span>
        <span className={styles.smallText}>
          Currently set to:{" "}
          {executeAllowedAt !== undefined
            ? `${new Date(Number(executeAllowedAt) * 1000).toLocaleString()}`
            : ""}
        </span>
      </div>

      <button
        className={`${styles.adminButton} ${styles.registerProviderBtn}`}
        onClick={handleRegisterProvider}
        title={
          !hasRegisteredProviders
            ? `No providers registered yet (count: ${providerCount})`
            : `${providerCount} provider(s) registered`
        }
      >
        Register New Mock Provider <br />
        <span className={styles.smallText}>
          Registered IDs: {formatProviderIds()}
        </span>
      </button>

      {/* Add Key to Provider Section */}
      <div className={styles.addKeySection}>
        <label className={styles.label}>Add key to Provider:</label>
        <div className={styles.inputGroup}>
          <select
            value={selectedProviderId}
            onChange={(e) => setSelectedProviderId(Number(e.target.value))}
            className={styles.select}
          >
            {events.length > 0 ? (
              events
                .map((event) => event.args.providerIdentifier)
                .filter(Boolean)
                .map((id) => (
                  <option key={id?.toString()} value={id?.toString()}>
                    Provider {id?.toString()}
                  </option>
                ))
            ) : (
              <option disabled value="">
                No registered providers
              </option>
            )}
          </select>
          <button
            className={`${styles.adminButton} ${styles.addKeyButton}`}
            onClick={handleAddKeysToProvider}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

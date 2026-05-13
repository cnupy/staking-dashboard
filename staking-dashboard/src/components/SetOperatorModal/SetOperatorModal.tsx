import { useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import StepSetOperator from "../StepSetOperator/StepSetOperator";
import type { MATPData } from "../../hooks/atp/matp";
import { useTransactionCart } from "@/contexts/TransactionCartContext";
import { buildUpdateStakerOperatorEntry } from "@/utils/actionCart";
import { formatAddress } from "../../utils/formatAddress";
import styles from "./SetOperatorModal.module.css";

interface SetOperatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  atp: MATPData | null;
  onSuccess?: () => void; // TODO: Implement data refetch
}

export default function SetOperatorModal({
  isOpen,
  onClose,
  atp,
}: SetOperatorModalProps) {
  const { address } = useAccount();
  const [isCompleted, setIsCompleted] = useState(false);
  const { addTransaction, openCart } = useTransactionCart();

  const getTypeName = (atp: MATPData) => {
    switch (atp.type) {
      case 1:
        return "Milestone ATP";
      case 2:
        return "Linear ATP";
      default:
        return "Unknown ATP";
    }
  };

  if (!isOpen || !atp) return null;

  const handleSetOperator = (operatorAddress: Address) => {
    if (!address || !atp) return;

    addTransaction(
      buildUpdateStakerOperatorEntry({
        atpAddress: atp.atpAddress as Address,
        operator: operatorAddress,
      }),
      { preventDuplicate: true },
    );
    setIsCompleted(true);
    openCart();
  };

  const handleClose = () => {
    setIsCompleted(false);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className={`${styles.modalContent} modal-content-base`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="close-button" onClick={handleClose}>
          ×
        </button>

        <div className={styles.modalBody}>
          <div className={styles.atpDetailsSection}>
            <div className={styles.sectionHeader}>
              <h2>Set Token Vault Operator</h2>
              <div className={styles.atpBadge}>
                <span className={styles.atpType}>{getTypeName(atp)}</span>
                {atp.milestoneId !== undefined && (
                  <span className={styles.milestoneId}>
                    Milestone {Number(atp.milestoneId) + 1}
                  </span>
                )}
              </div>
            </div>

            <div className={styles.description}>
              <p>
                The ATP operator has staking rights for this ATP. By default,
                the operator will be set to the owner of this ATP.
              </p>
              <p>
                To set an operator different than the ATP owner (beneficiary),
                please refer to the documentation for advanced configuration
                options.
              </p>
            </div>

            <div className={styles.atpInfoGrid}>
              <div className={styles.infoCard}>
                <h5 className={styles.infoLabel}>Allocation</h5>
                <p className={styles.infoValue}>
                  {atp.allocation
                    ? Number(formatEther(atp.allocation)).toLocaleString()
                    : "0"}{" "}
                  AZTEC
                </p>
              </div>

              <div className={styles.infoCard}>
                <h5 className={styles.infoLabel}>ATP Address</h5>
                <p className={styles.infoValueCode}>
                  {formatAddress(atp.atpAddress)}
                </p>
              </div>

              <div className={styles.infoCard}>
                <h5 className={styles.infoLabel}>Current Operator</h5>
                <p className={styles.infoValueCode}>
                  {atp.operator === "0x0000000000000000000000000000000000000000"
                    ? "Not set"
                    : formatAddress(atp.operator!)}
                </p>
              </div>

              <div className={styles.infoCard}>
                <h5 className={styles.infoLabel}>Beneficiary</h5>
                <p className={styles.infoValueCode}>
                  {atp.beneficiary ? formatAddress(atp.beneficiary) : "N/A"}
                </p>
              </div>
            </div>
          </div>

          <div className={styles.operatorSection}>
            <h3 className={styles.operatorSectionTitle}>New operator</h3>
            <StepSetOperator
              beneficiary={address}
              currentOperator={atp.operator as Address}
              isLoading={false}
              isCompleted={isCompleted}
              canExecute={!!address}
              onSetOperator={handleSetOperator}
            />

            {isCompleted && (
              <div className={styles.successMessage}>
                Operator queued in batch. Open the cart to execute.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

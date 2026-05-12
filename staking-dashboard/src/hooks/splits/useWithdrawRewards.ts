import { useWriteContract, useWaitForTransactionReceipt } from "@/hooks/useWagmiStrategy"
import { encodeFunctionData, type Address } from "viem"
import { SplitsWarehouseAbi } from "@/contracts/abis/SplitsWarehouse"
import type { RawTransaction } from "@/contexts/TransactionCartContextType"

/**
 * Build a `SplitsWarehouse.withdraw(user, token)` raw transaction.
 */
export function buildWithdrawRewardsTx(
  warehouseAddress: Address,
  userAddress: Address,
  tokenAddress: Address,
): RawTransaction {
  return {
    to: warehouseAddress,
    data: encodeFunctionData({
      abi: SplitsWarehouseAbi,
      functionName: "withdraw",
      args: [userAddress, tokenAddress],
    }),
    value: 0n,
  }
}

/**
 * Hook to withdraw rewards from SplitsWarehouse after distribute() has been called
 * Step 2: Call withdraw() on the SplitsWarehouse contract to claim the user's share
 */
export function useWithdrawRewards(warehouseAddress: Address | undefined) {
  const write = useWriteContract()

  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
  })

  return {
    withdraw: (userAddress: Address, tokenAddress: Address) => {
      if (!warehouseAddress) {
        throw new Error("Warehouse address not available")
      }
      return write.writeContract({
        abi: SplitsWarehouseAbi,
        address: warehouseAddress,
        functionName: "withdraw",
        args: [userAddress, tokenAddress],
      })
    },
    reset: write.reset,
    txHash: write.data,
    error: write.error || receipt.error,
    isPending: write.isPending,
    isConfirming: receipt.isLoading,
    isSuccess: receipt.isSuccess,
    isError: write.isError || receipt.isError,
  }
}

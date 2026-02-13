import { useState, useEffect, useRef } from "react"
import { useDistributeRewards } from "./useDistributeRewards"
import { useWithdrawRewards } from "./useWithdrawRewards"
import { useSplitsWarehouse } from "./useSplitsWarehouse"
import { useClaimSequencerRewards } from "@/hooks/rollup/useClaimSequencerRewards"
import type { Address } from "viem"
import type { SplitData, ClaimStep } from "./types"

interface BalanceData {
  rollupBalance?: bigint
  splitContractBalance?: bigint
  warehouseBalance?: bigint
  refetchRollup?: () => Promise<any>
  refetchSplitContract?: () => Promise<any>
  refetchWarehouse?: () => Promise<any>
}

type QueueStep = 'claiming' | 'distributing' | 'withdrawing'

/**
 * Hook to manage the complete claim flow for split contract rewards
 * Sequential flow: claim from rollup → distribute to warehouse → withdraw to user
 * Skips steps with zero balances
 */
export const useClaimSplitRewards = (
  splitContractAddress: Address | undefined,
  splitData: SplitData,
  tokenAddress: Address | undefined,
  userAddress: Address | undefined,
  balances?: BalanceData
) => {
  const [queue, setQueue] = useState<QueueStep[]>([])
  const [claimStep, setClaimStep] = useState<ClaimStep>('idle')
  const [skipMessage, setSkipMessage] = useState<string | null>(null)
  const [completedMessage, setCompletedMessage] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [refetchError, setRefetchError] = useState<Error | null>(null)

  // Track which step is currently completing to prevent duplicate timeout scheduling
  const completingStepRef = useRef<QueueStep | null>(null)

  // Get warehouse address from split contract
  const { warehouseAddress, isLoading: isLoadingWarehouse } = useSplitsWarehouse(splitContractAddress)

  const claimHook = useClaimSequencerRewards()
  const distributeHook = useDistributeRewards(splitContractAddress)
  const withdrawHook = useWithdrawRewards(warehouseAddress)

  /**
   * Queue processor - processes first item in queue
   */
  useEffect(() => {
    if (queue.length === 0) {
      setClaimStep('idle')
      return
    }

    if (isProcessing) return

    const currentStep = queue[0]
    setClaimStep(currentStep as ClaimStep)

    // CLAIMING
    if (currentStep === 'claiming') {
      const balance = balances?.rollupBalance
      // Wait for balance to load before processing
      if (balance === undefined) return

      if (balance === 0n) {
        setSkipMessage('No rewards to claim from rollup')
        setTimeout(() => {
          setSkipMessage(null)
          setQueue(prev => prev.filter(step => step !== 'claiming'))
        }, 1000)
      } else if (splitContractAddress) {
        setIsProcessing(true)
        claimHook.claimRewards(splitContractAddress)
      }
      return
    }

    // DISTRIBUTING
    if (currentStep === 'distributing') {
      const balance = balances?.splitContractBalance
      // Wait for balance to load before processing
      if (balance === undefined) return

      if (balance === 0n) {
        setSkipMessage('No rewards to distribute')
        setTimeout(() => {
          setSkipMessage(null)
          setQueue(prev => prev.filter(step => step !== 'distributing'))
        }, 1000)
      } else if (tokenAddress) {
        setIsProcessing(true)
        distributeHook.distribute(splitData, tokenAddress)
      }
      return
    }

    // WITHDRAWING
    if (currentStep === 'withdrawing') {
      const balance = balances?.warehouseBalance
      // Wait for balance to load before processing
      if (balance === undefined) return

      if (balance === 0n) {
        setSkipMessage('No rewards to withdraw')
        setTimeout(() => {
          setSkipMessage(null)
          setQueue(prev => prev.filter(step => step !== 'withdrawing'))
        }, 1000)
      } else if (userAddress && tokenAddress) {
        setIsProcessing(true)
        withdrawHook.withdraw(userAddress, tokenAddress)
      }
      return
    }
  }, [queue, balances])

  // Handle transaction success - show completion message, refetch balances, then remove from queue
  useEffect(() => {
    if (!isProcessing || queue.length === 0) return

    const currentStep = queue[0]
    let stepCompleted = false
    let message = ''
    let stepToRemove: QueueStep | null = null

    if (currentStep === 'claiming' && claimHook.isSuccess) {
      stepCompleted = true
      message = 'Claimed successfully'
      stepToRemove = 'claiming'
    } else if (currentStep === 'distributing' && distributeHook.isSuccess) {
      stepCompleted = true
      message = 'Distributed successfully'
      stepToRemove = 'distributing'
    } else if (currentStep === 'withdrawing' && withdrawHook.isSuccess) {
      stepCompleted = true
      message = 'Withdrawn successfully'
      stepToRemove = 'withdrawing'
    }

    if (stepCompleted && stepToRemove) {
      // Guard: prevent duplicate timeout scheduling if already completing this step
      if (completingStepRef.current === stepToRemove) return

      completingStepRef.current = stepToRemove
      setCompletedMessage(message)

      // Determine which balances need refetching for the NEXT step
      const refetchPromises: Promise<any>[] = []

      if (stepToRemove === 'claiming') {
        // Next step is 'distributing', which checks splitContractBalance
        if (balances?.refetchSplitContract) {
          refetchPromises.push(balances.refetchSplitContract())
        }
      } else if (stepToRemove === 'distributing') {
        // After distributing, tokens move from split contract to warehouse
        // Refetch BOTH balances to keep the UI accurate
        if (balances?.refetchSplitContract) {
          refetchPromises.push(balances.refetchSplitContract())
        }
        if (balances?.refetchWarehouse) {
          refetchPromises.push(balances.refetchWarehouse())
        }
      }

      // Wait for refetch to complete before advancing
      if (refetchPromises.length > 0) {
        Promise.all(refetchPromises)
          .then(() => {
            // Refetch succeeded - advance to next step after delay
            setTimeout(() => {
              setCompletedMessage(null)
              setIsProcessing(false)
              setQueue(prev => prev.filter(step => step !== stepToRemove))
              completingStepRef.current = null // Clear ref after advancing
            }, 500)
          })
          .catch(err => {
            console.error('Balance refetch failed:', err)
            // Treat refetch failure as an error - halt the flow completely
            setRefetchError(err instanceof Error ? err : new Error('Balance refetch failed'))
            setCompletedMessage(null)
            setQueue([])
            setClaimStep('idle')
            setIsProcessing(false)
            completingStepRef.current = null // Clear ref on error
          })
      } else {
        // No refetch needed (e.g., last step) - advance immediately
        setTimeout(() => {
          setCompletedMessage(null)
          setIsProcessing(false)
          setQueue(prev => prev.filter(step => step !== stepToRemove))
          completingStepRef.current = null // Clear ref after advancing
        }, 500)
      }
    }
  }, [queue, claimHook.isSuccess, distributeHook.isSuccess, withdrawHook.isSuccess, isProcessing, balances])

  // Handle errors - reset queue
  useEffect(() => {
    if (claimHook.isError || distributeHook.isError || withdrawHook.isError) {
      setSkipMessage(null)
      setQueue([])
      setClaimStep('idle')
      setIsProcessing(false)
      setRefetchError(null)
      completingStepRef.current = null
      claimHook.reset()
      distributeHook.reset()
      withdrawHook.reset()
    }
  }, [claimHook.isError, distributeHook.isError, withdrawHook.isError])

  const claim = () => {
    if (!warehouseAddress) return
    setSkipMessage(null)
    setRefetchError(null)
    setIsProcessing(false)
    completingStepRef.current = null
    setQueue(['claiming', 'distributing', 'withdrawing'])
  }

  const isClaiming = queue.length > 0
  const isSuccess = queue.length === 0 && withdrawHook.isSuccess

  return {
    claim,
    claimStep,
    skipMessage,
    completedMessage,
    warehouseAddress,
    isLoading: isLoadingWarehouse,
    isClaiming,
    isSuccess,
    isError: claimHook.isError || distributeHook.isError || withdrawHook.isError || !!refetchError,
    error: refetchError || claimHook.error || distributeHook.error || withdrawHook.error,
    claimTxHash: claimHook.txHash,
    distributeTxHash: distributeHook.txHash,
    withdrawTxHash: withdrawHook.txHash,
    reset: () => {
      setQueue([])
      setClaimStep('idle')
      setSkipMessage(null)
      setCompletedMessage(null)
      setIsProcessing(false)
      setRefetchError(null)
      completingStepRef.current = null
      claimHook.reset()
      distributeHook.reset()
      withdrawHook.reset()
    }
  }
}

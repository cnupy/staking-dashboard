import type { Address } from "viem"

export interface SplitData {
  recipients: Address[]
  allocations: bigint[]
  totalAllocation: bigint
  distributionIncentive: number
}

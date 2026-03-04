import { ProviderTable } from "@/components/Provider/ProviderTable"
import { ProviderSearch } from "@/components/Provider/ProviderSearch"
import { Pagination } from "@/components/Pagination"
import { DecentralizationDisclaimer } from "@/components/DecentralizationDisclaimer"
import { useProviderTable } from "@/hooks/providers/useProviderTable"
import { useProviderTableDisplayData } from "@/hooks/providers/useProviderTableDisplayData"
import { useProviderDisclaimer } from "@/hooks/providers/useProviderDisclaimer"
import { applyHeroItalics } from "@/utils/typographyUtils"

/**
 * Providers section component
 * Displays staking providers with search and pagination
 */
export const ProvidersSection = () => {
  const {
    providers,
    allProviders,
    isLoading: isLoadingProviders,
    sortField,
    sortDirection,
    hasUserSorted,
    handleSort,
    searchQuery,
    handleSearchChange,
    currentPage,
    totalPages,
    setCurrentPage,
    notAssociatedStake,
    tableTopRef
  } = useProviderTable()

  const {
    disclaimerProvider,
    handleStakeClick,
    handleDisclaimerProceed,
    handleDisclaimerCancel
  } = useProviderDisclaimer(allProviders)

  const {
    myDelegations,
    queueLengths,
    configurations,
    topGroupSize,
    showDecentralizationBar,
    topGroupSizeThreshold,
  } = useProviderTableDisplayData({
    providers,
    sortField,
    sortDirection,
    currentPage,
    searchQuery,
    hasUserSorted,
  })

  return (
    <div className="relative z-20 mb-0 opacity-0 animate-fade-up bg-ink/8 border border-ink/20 backdrop-blur-sm" style={{ animationDelay: '200ms' }}>
      {/* Background Texture */}
      <div className="pointer-events-none opacity-[0.08] absolute inset-0 z-0">
        <div
          className="absolute inset-0 h-full"
          style={{
            backgroundImage: "url('/assets/Aztec%20Image_28.webp')",
            backgroundPosition: 'center top',
            backgroundRepeat: 'repeat'
          }}
        ></div>
      </div>

      <div className="relative z-10 px-4 sm:px-6 lg:px-10 pb-4 sm:pb-6 lg:pb-10">
        {/* Header */}
        <div className="pt-12 pb-8">
          <div className="flex items-center gap-6">
            <div className="w-1 h-8 bg-chartreuse"></div>
            <h2 className="font-arizona-serif text-3xl sm:text-4xl text-parchment">
              {applyHeroItalics("Providers")}
            </h2>
            <div className="flex-1 h-px bg-parchment/20"></div>
          </div>
        </div>

        {/* Content Container */}
        <div className="relative mb-12">
          {/* Search Bar */}
          <ProviderSearch
            searchQuery={searchQuery}
            onSearchChange={handleSearchChange}
          />

          {/* Table */}
          <div ref={tableTopRef} className="mb-8">
            <ProviderTable
              providers={providers}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              onStakeClick={handleStakeClick}
              isLoading={isLoadingProviders}
              myDelegations={myDelegations}
              queueLengths={queueLengths}
              notAssociatedStake={notAssociatedStake}
              providerConfigurations={configurations}
              topGroupSize={topGroupSize}
              showDecentralizationBar={showDecentralizationBar}
              decentralizationBarAfterCount={topGroupSizeThreshold}
            />
          </div>

          {/* Pagination */}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            itemsPerPage={10}
            totalItems={allProviders.length}
          />
        </div>

        {/* Bridge Section */}
        <div className="">
          <div className="text-center max-w-3xl mx-auto">
            <div className="flex items-center justify-center gap-3 mb-6">
              <div className="h-px w-16 bg-gradient-to-r from-transparent to-chartreuse/40"></div>
              <div className="w-2 h-2 bg-chartreuse rotate-45"></div>
              <div className="h-px w-16 bg-gradient-to-l from-transparent to-chartreuse/40"></div>
            </div>
            <h3 className="font-arizona-serif text-3xl sm:text-4xl text-parchment mb-4">
              {applyHeroItalics("Manage Your Stakes")}
            </h3>
            <p className="font-arizona-text text-parchment/70 text-lg leading-relaxed mb-8">
              Track your active positions, monitor rewards, and manage your staking portfolio below
            </p>
            <div className="flex items-center justify-center gap-2">
              <div className="w-1 h-1 bg-chartreuse/60 rounded-full animate-pulse"></div>
              <div className="w-1 h-1 bg-chartreuse/60 rounded-full animate-pulse" style={{ animationDelay: '200ms' }}></div>
              <div className="w-1 h-1 bg-chartreuse/60 rounded-full animate-pulse" style={{ animationDelay: '400ms' }}></div>
            </div>
          </div>
        </div>
      </div>

      {disclaimerProvider && (
        <DecentralizationDisclaimer
          operatorName={disclaimerProvider.name}
          operatorRank={disclaimerProvider.rank}
          onProceed={handleDisclaimerProceed}
          onCancel={handleDisclaimerCancel}
        />
      )}
    </div>
  )
}

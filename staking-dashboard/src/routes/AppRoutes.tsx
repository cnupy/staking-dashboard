// routes/AppRoutes.tsx
import { Navigate, Route, Routes } from "react-router-dom"
import SharedLayout from "../layouts/SharedLayout"
import BaseLayout from "../layouts/BaseLayout"
import { MyPositionPage } from "../pages/ATP"
import { RegisterValidatorPage } from "../pages/RegisterValidator"
import { StakingProvidersPage, StakingProviderDetailPage } from "../pages/Providers"
import StakePortal from "@/pages/StakePortal/StakePortal"
import { OperatorPage } from "@/pages/Operator"
import { NotFoundPage } from "@/pages/NotFound/NotFoundPage"
import { useConnectedOperatorIdentities } from "@/hooks/operator"

/**
 * Route guard for `/operator`. Renders the page only for wallets that have
 * a confirmed operator identity (admin or rewards recipient on at least
 * one provider). Anyone else — including a previously-operator wallet
 * after switching to a non-operator one — is redirected to the default
 * position view. We wait for the identity query to settle before bouncing
 * to avoid a transient redirect on the operator's own first paint.
 *
 * One subtlety: when the indexer query FAILS we cannot prove the wallet
 * isn't an operator (we just don't know). Bouncing to `/` in that case
 * would hide a real operator from their own page AND from the retry
 * banner the page renders. Pass them through; the page surfaces the
 * error + retry button.
 */
function OperatorRouteGuard() {
  const { all, isLoading, hasError } = useConnectedOperatorIdentities()
  if (isLoading) return null
  if (all.length === 0 && !hasError) return <Navigate to="/" replace />
  return <OperatorPage />
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<SharedLayout />}>
        <Route path="/" element={<MyPositionPage />} />
        <Route path="/providers" element={<StakingProvidersPage />} />
        <Route path="/providers/:id" element={<StakingProviderDetailPage />} />
        <Route path="/my-position" element={<MyPositionPage />} />
        <Route path="/stake" element={<StakePortal />} />
        <Route path="/register-validator" element={<RegisterValidatorPage />} />
        <Route path="/operator" element={<OperatorRouteGuard />} />
      </Route>
      {/* Governance is disabled - redirect to home */}
      <Route path="/governance/*" element={<Navigate to="/" replace />} />
      <Route element={<BaseLayout />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

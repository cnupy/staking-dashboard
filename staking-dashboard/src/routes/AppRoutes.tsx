// routes/AppRoutes.tsx
import { Navigate, Route, Routes } from "react-router-dom"
import SharedLayout from "../layouts/SharedLayout"
import BaseLayout from "../layouts/BaseLayout"
import { MyPositionPage } from "../pages/ATP"
import { RegisterValidatorPage } from "../pages/RegisterValidator"
import { StakingProvidersPage, StakingProviderDetailPage } from "../pages/Providers"
import StakePortal from "@/pages/StakePortal/StakePortal"
import { NotFoundPage } from "@/pages/NotFound/NotFoundPage"

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
      </Route>
      {/* Governance is disabled - redirect to home */}
      <Route path="/governance/*" element={<Navigate to="/" replace />} />
      <Route element={<BaseLayout />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

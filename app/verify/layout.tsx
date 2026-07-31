import type { ReactNode } from "react";

import { VERIFY_APPLICATIONS_OPEN } from "@/lib/verification-availability";
import { VerificationApplicationsClosed } from "./verification-applications-closed";
import "./verify.css";

export default function VerifyLayout({ children }: { children: ReactNode }) {
  return VERIFY_APPLICATIONS_OPEN ? children : <VerificationApplicationsClosed />;
}

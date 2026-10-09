import type { DesktopResponseRepository } from "./desktop-response-store.js";
import type { DesktopResponseValue } from "./desktop-response-value.js";
import type { DesktopStateRepository } from "./desktop-state-store.js";
import type { DesktopThreadIdentity, DesktopTransportPort } from "./desktop-types.js";

export interface DesktopResponseInput extends DesktopResponseValue {
  target: DesktopThreadIdentity;
  desktopId: string;
  controllerSession: string;
  interactionId: string;
  responseId: string;
}
export interface DesktopResponseDependencies {
  repository: DesktopResponseRepository;
  tasks: DesktopStateRepository;
  observe: DesktopTransportPort["observe"];
  answerAsync: NonNullable<DesktopTransportPort["answerAsync"]>;
  respondRequest?: NonNullable<DesktopTransportPort["respondRequest"]>;
  now?(): Date;
  randomUUID?(): string;
}

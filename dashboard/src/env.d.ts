/// <reference types="vite/client" />

declare module "@motionone/solid" {
  import type { JSX, Component } from "solid-js";

  type MotionProps = {
    animate?: Record<string, unknown>;
    initial?: Record<string, unknown>;
    exit?: Record<string, unknown>;
    transition?: Record<string, unknown>;
  };

  type MotionProxy = {
    [K in keyof JSX.IntrinsicElements]: Component<
      JSX.IntrinsicElements[K] & MotionProps
    >;
  };

  export const Motion: MotionProxy;
  export const Presence: Component<{
    exitBeforeEnter?: boolean;
    children: JSX.Element;
  }>;
}

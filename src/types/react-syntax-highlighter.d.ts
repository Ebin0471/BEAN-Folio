// Minimal ambient types for react-syntax-highlighter (types package not installed).
declare module "react-syntax-highlighter" {
  import type { ComponentType, CSSProperties, ReactNode } from "react";
  export interface SyntaxHighlighterProps {
    children: ReactNode;
    language?: string;
    style?: unknown;
    customStyle?: CSSProperties;
    wrapLongLines?: boolean;
    showLineNumbers?: boolean;
    className?: string;
  }
  export const Prism: ComponentType<SyntaxHighlighterProps>;
  export const Light: ComponentType<SyntaxHighlighterProps>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism" {
  export const oneDark: Record<string, unknown>;
  export const vscDarkPlus: Record<string, unknown>;
}

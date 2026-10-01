import 'server-only';

import type { ComponentType, ImgHTMLAttributes, ReactElement } from 'react';
import type { MDXComponents } from 'mdx/types';
import { Figure } from './Figure.server';
import { ImageOcclusion } from './ImageOcclusion.server';
import { MCQ } from './MCQ.server';

type MdxContentComponent = ComponentType<{ components?: MDXComponents }>;

/**
 * Resolve ordinary Markdown images through the same entitlement and sidecar
 * boundary as an explicit MDX <Figure>. The global mdx-components module must
 * remain client-safe because generated deep-dive loader maps are imported by
 * client components, so server overrides are supplied at the render sites.
 */
async function ServerMdxImage({
  src,
  alt,
  title,
}: ImgHTMLAttributes<HTMLImageElement>) {
  if (typeof src !== 'string' || src.length === 0) return null;
  return <Figure src={src} alt={alt ?? ''} caption={title} />;
}

export const SERVER_MDX_COMPONENTS: MDXComponents = {
  Figure,
  ImageOcclusion,
  MCQ,
  img: ServerMdxImage,
};

/** Render a compiled MDX module with server-side media resolution enabled. */
export function renderMdxContent(Content: ComponentType): ReactElement {
  const MdxContent = Content as MdxContentComponent;
  return <MdxContent components={SERVER_MDX_COMPONENTS} />;
}

/**
 * Remark plugin to strip YAML frontmatter nodes from the AST.
 * remark-frontmatter parses frontmatter but doesn't remove it from rendering.
 * This plugin removes the parsed YAML nodes so they don't appear in output.
 */

import type { Root } from 'mdast';

export function remarkStripFrontmatter() {
  return (tree: Root) => {
    tree.children = tree.children.filter(node => node.type !== 'yaml');
  };
}

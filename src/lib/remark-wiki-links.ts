/**
 * Remark plugin to transform [[wiki-link]] syntax into WikiLink components
 *
 * Transforms:
 *   [[shock]] → <WikiLink slug="shock" />
 *   [[shock|about shock]] → <WikiLink slug="shock">about shock</WikiLink>
 */

import { visit } from 'unist-util-visit';
import type { Root, Parents, PhrasingContent, Text } from 'mdast';
import type { MdxJsxTextElement, MdxJsxAttribute } from 'mdast-util-mdx-jsx';

// Regex to match [[slug]] or [[slug|text]]
const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function remarkWikiLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;
      const matches = [...value.matchAll(WIKI_LINK_REGEX)];

      if (matches.length === 0) return;

      // Build new nodes to replace this text node
      const newNodes: (Text | MdxJsxTextElement)[] = [];
      let lastIndex = 0;

      for (const match of matches) {
        const [fullMatch, slug, displayText] = match;
        const matchIndex = match.index!;

        // Add text before the match
        if (matchIndex > lastIndex) {
          newNodes.push({
            type: 'text',
            value: value.slice(lastIndex, matchIndex),
          } satisfies Text);
        }

        // Add WikiLink component as MDX JSX element
        const wikiLinkNode: MdxJsxTextElement = {
          type: 'mdxJsxTextElement',
          name: 'WikiLink',
          attributes: [
            {
              type: 'mdxJsxAttribute',
              name: 'slug',
              value: slug.trim().toLowerCase().replace(/\s+/g, '-'),
            } satisfies MdxJsxAttribute,
          ],
          children: displayText
            ? [{ type: 'text', value: displayText.trim() } as Text]
            : [],
        };

        newNodes.push(wikiLinkNode);
        lastIndex = matchIndex + fullMatch.length;
      }

      // Add remaining text after last match
      if (lastIndex < value.length) {
        newNodes.push({
          type: 'text',
          value: value.slice(lastIndex),
        } satisfies Text);
      }

      // Replace the original node with the new nodes
      const parentNode = parent as Parents;
      (parentNode.children as PhrasingContent[]).splice(index, 1, ...newNodes);
    });
  };
}

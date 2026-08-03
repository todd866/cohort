import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './frontmatter';

const contentDirectory = path.join(process.cwd(), 'content');

export interface WeekMeta {
  title: string;
  week: number;
  rotation: string;
  topics: string[];
  questionCount?: number;
}

export function getWeekContent(rotation: string, week: number) {
  const weekDir = path.join(contentDirectory, rotation);

  // Find the MDX file for this week
  const files = fs.existsSync(weekDir) ? fs.readdirSync(weekDir) : [];
  const weekFile = files.find(f => f.includes(`week${week}`) && f.endsWith('.mdx'));

  if (!weekFile) {
    return null;
  }

  const fullPath = path.join(weekDir, weekFile);
  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data, content } = parseFrontmatter<WeekMeta>(fileContents);

  return {
    meta: data as WeekMeta,
    content,
    slug: weekFile.replace('.mdx', ''),
  };
}

export function getAllWeeks(rotation: string): WeekMeta[] {
  const weekDir = path.join(contentDirectory, rotation);

  if (!fs.existsSync(weekDir)) {
    return [];
  }

  const files = fs.readdirSync(weekDir).filter(f => f.endsWith('.mdx'));

  return files.map(file => {
    const fullPath = path.join(weekDir, file);
    const fileContents = fs.readFileSync(fullPath, 'utf8');
    const { data } = parseFrontmatter<WeekMeta>(fileContents);
    return data;
  }).sort((a, b) => a.week - b.week);
}

export function getRotations() {
  if (!fs.existsSync(contentDirectory)) {
    return [];
  }

  return fs.readdirSync(contentDirectory)
    .filter(f => fs.statSync(path.join(contentDirectory, f)).isDirectory());
}

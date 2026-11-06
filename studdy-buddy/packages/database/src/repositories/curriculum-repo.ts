import type { CurriculumGraph, CurriculumNode, CurriculumNodeKind } from '@studdy/shared';
import type { SqlDriver } from '../driver.js';

interface NodeRow {
  id: string;
  course_id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  ordinal: number | null;
  url: string | null;
  platform_completed: number | null;
  inaccessible: number;
  discovered_at: string;
}

/**
 * Stores the discovered curriculum graph.
 *
 * When a page is re-discovered we replace the whole graph for that course: a
 * curriculum is one coherent document, and partial merges across versions
 * produce phantom modules (the exact failure the spec warns about).
 */
export class CurriculumRepo {
  constructor(private readonly db: SqlDriver) {}

  saveGraph(graph: CurriculumGraph): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO curriculum_course (id, name, source_url, discovered_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, source_url = excluded.source_url, discovered_at = excluded.discovered_at`,
        [graph.courseId, graph.courseName, graph.sourceUrl, graph.discoveredAt],
      );
      this.db.run('DELETE FROM curriculum_node WHERE course_id = ?', [graph.courseId]);
      for (const node of graph.nodes) {
        this.db.run(
          `INSERT INTO curriculum_node (id, course_id, parent_id, kind, title, ordinal, url, platform_completed, inaccessible, discovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            node.id,
            graph.courseId,
            node.parentId,
            node.kind,
            node.title,
            node.order,
            node.url,
            node.platformCompleted === null ? null : node.platformCompleted ? 1 : 0,
            node.inaccessible ? 1 : 0,
            graph.discoveredAt,
          ],
        );
      }
    });
  }

  loadGraph(courseId: string): CurriculumGraph | null {
    const course = this.db.get<{ id: string; name: string; source_url: string; discovered_at: string }>(
      'SELECT * FROM curriculum_course WHERE id = ?',
      [courseId],
    );
    if (!course) return null;
    const rows = this.db.all<NodeRow>('SELECT * FROM curriculum_node WHERE course_id = ? ORDER BY kind, ordinal, rowid', [courseId]);
    return {
      courseId: course.id,
      courseName: course.name,
      sourceUrl: course.source_url,
      discoveredAt: course.discovered_at,
      nodes: rows.map(mapNode),
    };
  }

  latestCourse(): CurriculumGraph | null {
    const row = this.db.get<{ id: string }>('SELECT id FROM curriculum_course ORDER BY discovered_at DESC LIMIT 1');
    return row ? this.loadGraph(row.id) : null;
  }

  setCompletion(courseId: string, nodeId: string, completed: boolean | null): void {
    this.db.run('UPDATE curriculum_node SET platform_completed = ? WHERE course_id = ? AND id = ?', [
      completed === null ? null : completed ? 1 : 0,
      courseId,
      nodeId,
    ]);
  }

  /**
   * Number of top-level MODULE nodes actually discovered. Used by the
   * acceptance test that requires we report the *real* count, never a hardcoded 17.
   */
  moduleCount(courseId: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM curriculum_node WHERE course_id = ? AND kind = 'MODULE'",
      [courseId],
    );
    return row?.n ?? 0;
  }
}

function mapNode(row: NodeRow): CurriculumNode {
  return {
    id: row.id,
    kind: row.kind as CurriculumNodeKind,
    title: row.title,
    order: row.ordinal,
    url: row.url,
    parentId: row.parent_id,
    platformCompleted: row.platform_completed === null ? null : row.platform_completed === 1,
    inaccessible: row.inaccessible === 1,
  };
}

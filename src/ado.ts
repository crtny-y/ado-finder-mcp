import axios, { AxiosError } from 'axios';

export interface WorkItem {
  id: number;
  title: string;
  state: string;
  assignedTo: string | null;
  url: string;
  reason: string;
  workItemType: string;
  areaPath: string;
}

interface SearchResult {
  fields: Record<string, string>;
}

interface WorkItemDetail {
  id: number;
  fields: Record<string, unknown>;
}

function createAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

export async function searchWithSearchAPI(
  org: string,
  project: string,
  pat: string,
  keyword: string,
  topK: number,
): Promise<WorkItem[]> {
  const url = `https://almsearch.dev.azure.com/${org}/${project}/_apis/search/workitemsearchresults?api-version=7.1`;
  const body = {
    searchText: keyword,
    $skip: 0,
    $top: topK,
    filters: {
      'System.State': ['Active', 'New', 'Committed', 'Open', 'In Progress', 'To Do', 'Proposed'],
      'System.WorkItemType': ['Feature'],
    },
  };
  try {
    const res = await axios.post(url, body, {
      headers: { Authorization: createAuthHeader(pat), 'Content-Type': 'application/json' },
    });
    return (res.data.results ?? []).map((r: SearchResult) => ({
      id: parseInt(r.fields['system.id']),
      title: r.fields['system.title'] ?? '',
      state: r.fields['system.state'] ?? '',
      assignedTo: r.fields['system.assignedto'] ?? null,
      url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${r.fields['system.id']}`,
      reason: 'Found via Search API',
      workItemType: r.fields['system.workitemtype'] ?? '',
      areaPath: r.fields['system.areapath'] ?? '',
    }));
  } catch (err) {
    const e = err as AxiosError;
    if (e.response && (e.response.status === 403 || e.response.status === 404)) {
      throw new Error('FALLBACK_REQUIRED');
    }
    throw err;
  }
}

export async function searchWithWIQL(
  org: string,
  project: string,
  pat: string,
  keyword: string,
  topK: number,
): Promise<WorkItem[]> {
  const auth = createAuthHeader(pat);
  const safe = keyword.replace(/'/g, "''");
  const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=7.1`;

  const wiqlRes = await axios.post(
    wiqlUrl,
    {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Tags], [System.Description]
              FROM WorkItems
              WHERE [System.TeamProject] = @project
              AND [System.WorkItemType] = 'Feature'
              AND [System.AreaPath] UNDER 'MSTeams'
              AND [System.State] <> 'Closed'
              AND [System.State] <> 'Resolved'
              AND [System.State] <> 'Removed'
              AND (
                [System.Title] CONTAINS '${safe}'
                OR [System.Tags] CONTAINS '${safe}'
                OR [System.Description] CONTAINS '${safe}'
              )`,
    },
    { headers: { Authorization: auth, 'Content-Type': 'application/json' } },
  );

  const ids: number[] = (wiqlRes.data.workItems ?? []).map((w: { id: number }) => w.id);
  if (ids.length === 0) return [];

  const detailRes = await axios.get(
    `https://dev.azure.com/${org}/${project}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.1`,
    { headers: { Authorization: auth } },
  );

  interface Scored extends WorkItem {
    score: number;
  }

  const keywordLower = keyword.toLowerCase();
  const scored: Scored[] = (detailRes.data.value ?? []).map((wi: WorkItemDetail) => {
    const title = String(wi.fields['System.Title'] ?? '');
    const tags = String(wi.fields['System.Tags'] ?? '');
    const description = String(wi.fields['System.Description'] ?? '');

    const titleLower = title.toLowerCase();
    const tagsLower = tags.toLowerCase();
    const descLower = description.toLowerCase();

    const titleMatches = (titleLower.match(new RegExp(keywordLower, 'g')) ?? []).length;
    const tagsMatches = (tagsLower.match(new RegExp(keywordLower, 'g')) ?? []).length;
    const descMatches = (descLower.match(new RegExp(keywordLower, 'g')) ?? []).length;

    const score = titleMatches * 10 + tagsMatches * 5 + descMatches;

    const assignedTo = wi.fields['System.AssignedTo'] as { displayName?: string } | null;

    return {
      id: wi.id,
      title,
      state: String(wi.fields['System.State'] ?? ''),
      assignedTo: assignedTo?.displayName ?? null,
      url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}`,
      reason: 'Found via WIQL fallback',
      workItemType: String(wi.fields['System.WorkItemType'] ?? ''),
      areaPath: String(wi.fields['System.AreaPath'] ?? ''),
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ score: _score, ...item }) => item);
}

export async function searchADOFeatures(keyword: string, topK = 10): Promise<WorkItem[]> {
  const { ADO_ORG: org, ADO_PROJECT: project, ADO_PAT: pat } = process.env;

  if (!org || !project || !pat) {
    throw new Error('Missing required environment variables: ADO_ORG, ADO_PROJECT, ADO_PAT');
  }

  if (!keyword || typeof keyword !== 'string') {
    throw new Error('Invalid request: keyword is required and must be a string');
  }

  try {
    const items = await searchWithSearchAPI(org, project, pat, keyword, topK);
    console.error(`Found ${items.length} items using Search API`);
    return items;
  } catch (error) {
    if (error instanceof Error && error.message === 'FALLBACK_REQUIRED') {
      console.error('Search API not available, falling back to WIQL');
      const items = await searchWithWIQL(org, project, pat, keyword, topK);
      console.error(`Found ${items.length} items using WIQL fallback`);
      return items;
    }
    throw error;
  }
}

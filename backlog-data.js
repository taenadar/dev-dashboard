// The dependency graph, curated by hand: Azure Boards has no predecessor links you'd want to draw from.
// Live state comes from /api/backlog: a row whose item is Done or Removed drops out on its own, and an open
// item that has no row here still shows in the graph as a dashed box without links. A row is only needed to draw edges.
// The ids below are examples: replace them with your own work item ids.
// Status override: 'active' | 'blocked' | 'close' (done but still open on the board) | '' (worked out from the edges).
// [id, code, short title, phase (p0|p1|p2|-), assignee, status override, blocker / note, external note]
const N = [
 [1001,'PBI-001','Sign-in and roles','p0','','',''],
 [1002,'PBI-002','Order list','p0','','',''],
 [1003,'PBI-003','Order detail','p0','','',''],
 [1004,'PBI-004','Export to CSV','p1','','',''],
 [1005,'PBI-005','Email notifications','p1','','blocked','Waits on the mail provider choice','Mail provider contract.'],
];
// [from, to, 'p' = only one acceptance criterion waits]
const E = [
 [1001,1002],[1002,1003],[1002,1004],[1003,1005,'p'],
];

// The forecast replays the pace of the last 28 days, but never days before this date (e.g. a bulk import of the
// backlog, which would look like a burst of new work). Leave it empty to use the last 28 days.
const PACE_FROM = '';

// Target dates shown on the hero tiles and the burndown. code 'P0' gets a forecast against the P0 pace.
const MILESTONES = [
 { code:'P0', name:'P0 go-live', date:'2027-03-31', soft:true },
];

/* Absence correlation.

   Ranks players by how much of their observed presence happened while none of the
   watched admins were on the same server. Someone who only ever turns up when the
   admins are away is the signal we are looking for.

   Port of the SQL version, which has a test suite behind it. Two rules matter and
   both are easy to break by accident:

   1. Servers where an admin has NEVER been seen are excluded. On those servers
      "absent" is true for everyone all the time, so including them flags the
      entire player base.
   2. Admins are never scored as candidates. They define the windows.

   Tallies are rolling: they describe polls that already happened. Changing who is
   an admin affects future polls, not history. */

/**
 * @param {Array} statsRows  rows of {playerId, serverId, lastName, total, absent, present, lastSeen}
 * @param {Set}   adminIds   player ids flagged as admins
 * @param {Set}   activeServers server ids where an admin has been seen (adminPolls > 0)
 * @param {number} minSightings floor below which a player is too sparse to judge
 */
export function correlate(statsRows, adminIds, activeServers, minSightings = 3) {
  const byPlayer = new Map();

  for (const r of statsRows) {
    if (!activeServers.has(String(r.serverId))) continue;
    if (adminIds.has(String(r.playerId))) continue;

    const key = String(r.playerId);
    let s = byPlayer.get(key);
    if (!s) {
      s = {
        playerId: key, name: r.lastName || "", total: 0, absent: 0, present: 0,
        lastSeen: r.lastSeen || null, servers: new Set(),
      };
      byPlayer.set(key, s);
    }
    s.name = r.lastName || s.name;
    s.total += r.total || 0;
    s.absent += r.absent || 0;
    s.present += r.present || 0;
    s.servers.add(String(r.serverId));
    if (r.lastSeen && (!s.lastSeen || r.lastSeen > s.lastSeen)) s.lastSeen = r.lastSeen;
  }

  const candidates = [];
  for (const s of byPlayer.values()) {
    if (s.total < minSightings) continue;
    candidates.push({
      ...s,
      servers: [...s.servers].sort(),
      absentRatio: s.total ? Math.round((s.absent / s.total) * 1000) / 1000 : 0,
    });
  }
  candidates.sort((a, b) => (b.absentRatio - a.absentRatio) || (b.absent - a.absent));
  return candidates.slice(0, 200);
}

/** Context the UI needs to say whether the numbers mean anything yet. */
export function correlationMeta(servers, adminIds, minSightings) {
  let totalPolls = 0, adminPolls = 0, withAdmin = 0;
  for (const s of servers) {
    totalPolls += s.totalPolls || 0;
    adminPolls += s.adminPolls || 0;
    if ((s.adminPolls || 0) > 0) withAdmin++;
  }
  return {
    totalPolls, adminPolls, serversWithAdminActivity: withAdmin,
    admins: adminIds.size, minSightings,
  };
}

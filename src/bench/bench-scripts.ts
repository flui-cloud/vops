import { OsFamily } from '../hosts/host.model';
import { BenchProfile } from './bench.model';

/**
 * Pure builders for the bench battery. Every probe is one SSH `runScript` that
 * wraps its workload with a 1 s `/proc/stat` + `/proc/loadavg` sampler and emits
 * `@@name` sections parsed by `splitSections`. fio only ever touches
 * `/var/tmp/vops-bench/` (never `/tmp`, often tmpfs → would measure RAM) and its
 * test file is cleaned up via an EXIT trap. Kept dependency-free and testable.
 */
export type ProbeTool = 'sevenz' | 'openssl' | 'sysbench' | 'fio';
export type ProbeId =
  | 'cpu.multi'
  | 'cpu.single'
  | 'cpu.crypto'
  | 'mem.bw'
  | 'disk.rr4k'
  | 'disk.rw4k'
  | 'disk.sr1m'
  | 'disk.sw1m';

export interface ProbeSpec {
  id: ProbeId;
  tool: ProbeTool;
}

export const PROBE_SPECS: ProbeSpec[] = [
  { id: 'cpu.multi', tool: 'sevenz' },
  { id: 'cpu.single', tool: 'sevenz' },
  { id: 'cpu.crypto', tool: 'openssl' },
  { id: 'mem.bw', tool: 'sysbench' },
  { id: 'disk.rr4k', tool: 'fio' },
  { id: 'disk.rw4k', tool: 'fio' },
  { id: 'disk.sr1m', tool: 'fio' },
  { id: 'disk.sw1m', tool: 'fio' },
];

export const BENCH_DIR = '/var/tmp/vops-bench';
export const FIO_FILE = `${BENCH_DIR}/fio.dat`;
const SAMPLE_FILE = `${BENCH_DIR}/samples-$$.txt`;
const MARK = '@@';

const STAT = `awk '/^cpu /{s=$9;t=0;for(i=2;i<=NF;i++)t+=$i;print s" "t;exit}' /proc/stat`;

function samplerBlock(): string {
  return [
    `__vstat() { ${STAT}; }`,
    '__vsampler() {',
    '  while :; do',
    `    a=$(__vstat); l=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)`,
    '    sleep 1; b=$(__vstat)',
    `    awk -v a="$a" -v b="$b" -v l="$l" -v ts="$(date +%s)" 'BEGIN{split(a,p," ");split(b,q," ");dt=q[2]-p[2];ds=q[1]-p[1];st=(dt>0)?(ds/dt)*100:0;printf "%s %.2f %s\\n",ts,st,l}'`,
    '  done',
    '}',
  ].join('\n');
}

function wrap(id: ProbeId, workload: string[], removesFio: boolean): string {
  const cleanup = removesFio ? `${SAMPLE_FILE} ${FIO_FILE}` : SAMPLE_FILE;
  return [
    'set +e',
    'export LC_ALL=C',
    `mkdir -p ${BENCH_DIR}`,
    `: > ${SAMPLE_FILE}`,
    samplerBlock(),
    `__vsampler >> ${SAMPLE_FILE} 2>/dev/null &`,
    '__VSPID=$!',
    `trap 'kill $__VSPID 2>/dev/null; rm -f ${cleanup}' EXIT`,
    `echo "${MARK}${id}"`,
    ...workload,
    'kill $__VSPID 2>/dev/null',
    `echo "${MARK}samples"`,
    `cat ${SAMPLE_FILE} 2>/dev/null`,
    `echo "${MARK}end"`,
  ].join('\n');
}

function sevenz(passes: string, singleThread: boolean): string[] {
  const args = ['b', passes, singleThread ? '-mmt1' : ''].filter(Boolean).join(' ');
  return [
    'SEVENZ=$(command -v 7zz 2>/dev/null || command -v 7z 2>/dev/null)',
    `"$SEVENZ" ${args} 2>&1`,
  ];
}

function openssl(seconds: number): string[] {
  return [
    `openssl speed -mr -seconds ${seconds} -evp aes-256-gcm 2>/dev/null`,
    `openssl speed -mr -seconds ${seconds} -evp sha256 2>/dev/null`,
  ];
}

function sysbench(seconds: number): string[] {
  return [
    `sysbench memory --memory-block-size=1M --memory-total-size=100T --time=${seconds} run 2>&1`,
  ];
}

function fio(id: ProbeId, rw: string, bs: string, iodepth: number, runtime: number, size: string): string[] {
  return [
    `fio --ioengine=libaio --direct=1 --time_based --ramp_time=5 --filename=${FIO_FILE} ` +
      `--size=${size} --output-format=json --group_reporting --name=${id} ` +
      `--rw=${rw} --bs=${bs} --iodepth=${iodepth} --runtime=${runtime} 2>/dev/null`,
  ];
}

/** `keepFio` leaves fio.dat in place after disk.sw1m so interleaved rounds reuse it. */
export function buildProbeScript(id: ProbeId, profile: BenchProfile, keepFio = false): string {
  const full = profile === 'full';
  const size = full ? '1G' : '512M';
  const rr = full ? 45 : 20;
  const sq = full ? 30 : 15;
  switch (id) {
    case 'cpu.multi':
      return wrap(id, sevenz(full ? '' : '1', false), false);
    case 'cpu.single':
      return wrap(id, sevenz(full ? '' : '1', true), false);
    case 'cpu.crypto':
      return wrap(id, openssl(full ? 3 : 1), false);
    case 'mem.bw':
      return wrap(id, sysbench(15), false);
    case 'disk.rr4k':
      return wrap(id, fio(id, 'randread', '4k', 64, rr, size), false);
    case 'disk.rw4k':
      return wrap(id, fio(id, 'randwrite', '4k', 64, rr, size), false);
    case 'disk.sr1m':
      return wrap(id, fio(id, 'read', '1M', 8, sq, size), false);
    case 'disk.sw1m':
      return wrap(id, fio(id, 'write', '1M', 8, sq, size), !keepFio);
  }
}

const EXPECTED: Record<ProbeId, [number, number]> = {
  'cpu.multi': [40, 120],
  'cpu.single': [40, 120],
  'cpu.crypto': [15, 25],
  'mem.bw': [25, 25],
  'disk.rr4k': [30, 55],
  'disk.rw4k': [30, 55],
  'disk.sr1m': [25, 40],
  'disk.sw1m': [25, 40],
};

/** Rough per-probe runtime in seconds; the SSH timeout adds a 120 s margin on top. */
export function expectedSeconds(id: ProbeId, profile: BenchProfile): number {
  const [quick, full] = EXPECTED[id];
  return profile === 'full' ? full : quick;
}

function toolsBlock(): string {
  return [
    'for __t in fio sysbench 7zz 7z openssl; do',
    '  __p=$(command -v "$__t" 2>/dev/null)',
    '  if [ -z "$__p" ]; then printf "%s\\tMISSING\\t\\n" "$__t"; continue; fi',
    '  case "$__t" in',
    '    openssl) __v=$(openssl version 2>/dev/null) ;;',
    `    7z|7zz) __v=$("$__t" 2>/dev/null | grep -m1 -ioE '7-?zip[^,]*') ;;`,
    '    *) __v=$("$__t" --version 2>/dev/null | head -n1) ;;',
    '  esac',
    '  printf "%s\\t%s\\t%s\\n" "$__t" "$__p" "$__v"',
    'done',
  ].join('\n');
}

function metaBlock(): string {
  return [
    `printf 'kernel\\t%s\\n' "$(uname -r 2>/dev/null)"`,
    `printf 'cores\\t%s\\n' "$(nproc 2>/dev/null || echo 1)"`,
    `__cpu=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n1)`,
    `[ -z "$__cpu" ] && __cpu=$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1)`,
    '[ -z "$__cpu" ] && __cpu=unknown',
    `printf 'cpu\\t%s\\n' "$__cpu"`,
    `printf 'memkb\\t%s\\n' "$(grep -i MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')"`,
    '__virt=$(systemd-detect-virt 2>/dev/null); [ -z "$__virt" ] && __virt=unknown',
    `printf 'virt\\t%s\\n' "$__virt"`,
    `printf 'os\\t%s\\n' "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -n1)"`,
  ].join('\n');
}

function baseBlock(): string {
  return [
    `__b1=$(${STAT})`,
    'sleep 3',
    `__b2=$(${STAT})`,
    `__l=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)`,
    `awk -v a="$__b1" -v b="$__b2" -v l="$__l" 'BEGIN{split(a,p," ");split(b,q," ");dt=q[2]-p[2];ds=q[1]-p[1];st=(dt>0)?(ds/dt)*100:0;printf "%s %.2f\\n",l,st}'`,
  ].join('\n');
}

/** Read-only preflight: tool presence, free space, host meta, baseline load/steal. */
export function buildPreflightScript(): string {
  return [
    'set +e',
    'export LC_ALL=C',
    `mkdir -p ${BENCH_DIR}`,
    `echo "${MARK}tools"`,
    toolsBlock(),
    `echo "${MARK}space"`,
    'df -Pk /var/tmp 2>/dev/null',
    `echo "${MARK}meta"`,
    metaBlock(),
    `echo "${MARK}base"`,
    baseBlock(),
    `echo "${MARK}end"`,
  ].join('\n');
}

/** Best-effort package install per OS family; `null` when the family is unknown. */
export function buildInstallScript(family: OsFamily): string | null {
  if (family === 'debian') {
    return 'apt-get update -qq && apt-get install -y -qq fio sysbench 7zip || apt-get install -y -qq p7zip-full';
  }
  if (family === 'rhel') {
    return 'dnf install -y fio sysbench p7zip 2>/dev/null || yum install -y fio sysbench p7zip';
  }
  if (family === 'alpine') {
    return 'apk add --no-cache fio sysbench 7zip';
  }
  return null;
}

"""Build karaoke/data/dict.tsv.gz and kanji.json from the jamdict-data SQLite DB.

    pip download --no-deps jamdict-data && tar xzf jamdict_data-*.tar.gz
    xz -dk jamdict_data-*/jamdict_data/jamdict.db.xz
    python3 build_dict.py path/to/jamdict.db
"""
import gzip, json, re, sqlite3, sys, os
from collections import defaultdict

db = sqlite3.connect(sys.argv[1])
out = os.path.join(os.path.dirname(__file__), '..', 'data')

def grouped(sql):
    d = defaultdict(list)
    for k, v in db.execute(sql):
        d[k].append(v)
    return d

kanji = grouped('select idseq, text from Kanji order by ID')
kana = grouped('select idseq, text from Kana order by ID')
kjp = grouped('select k.idseq, p.text from Kanji k join KJP p on p.kid=k.ID')
knp = grouped('select k.idseq, p.text from Kana k join KNP p on p.kid=k.ID')
senses = grouped('select idseq, ID from Sense order by ID')
gloss = grouped("select sid, text from SenseGloss where lang is null or lang='eng' order by rowid")
pos = grouped('select sid, text from pos')

def short_pos(p):
    p = p.lower()
    for key, s in [('godan', 'v5'), ('ichidan', 'v1'), ('suru verb', 'vs'), ('kuru verb', 'vk'),
                   ('adjective (keiyoushi)', 'i-adj'), ('adjectival nouns', 'na-adj'),
                   ('adverb', 'adv'), ('noun', 'n'), ('pronoun', 'pron'), ('particle', 'prt'),
                   ('conjunction', 'conj'), ('interjection', 'int'), ('expression', 'exp'),
                   ('counter', 'ctr'), ('suffix', 'suf'), ('prefix', 'pref'), ('auxiliary', 'aux')]:
        if key in p:
            return s
    return ''

def score(tags):
    s = 0
    for t in tags:
        if t in ('ichi1', 'news1', 'spec1', 'gai1'): s += 10
        elif t in ('ichi2', 'news2', 'spec2', 'gai2'): s += 3
        elif t.startswith('nf'): s += max(0, 5 - int(t[2:]) // 10)
    return s

entries = []
for idseq, in db.execute('select idseq from Entry order by idseq'):
    if idseq not in kana:
        continue
    ss = []
    for sid in senses[idseq][:5]:
        g = gloss[sid][:4]
        if not g:
            continue
        ps = sorted({short_pos(p) for p in pos[sid]} - {''})
        ss.append([','.join(ps), '; '.join(g)])
    if not ss:
        continue
    entries.append([kanji[idseq][:4], kana[idseq][:3], score(kjp[idseq] + knp[idseq]), ss])

# One entry per line: kanji|kanji <TAB> kana|kana <TAB> score <TAB> pos\x1fgloss\x1epos\x1fgloss...
# The app only parses a line when it is looked up, which keeps memory low.
def clean(s):
    return s.replace('\t', ' ').replace('\n', ' ').replace('|', '/')
with gzip.open(os.path.join(out, 'dict.tsv.gz'), 'wt', encoding='utf-8', compresslevel=9) as f:
    for kj, kn, sc, ss in entries:
        f.write('\t'.join(['|'.join(map(clean, kj)), '|'.join(map(clean, kn)), str(sc),
                           '\x1e'.join(clean(p) + '\x1f' + clean(g) for p, g in ss)]) + '\n')

# Old JLPT levels: 4 ~ N5, 3 ~ N4, 2 ~ N3/N2
lv = {}
for lit, j in db.execute('select literal, jlpt from character where jlpt is not null'):
    lv[lit] = int(j)
with open(os.path.join(out, 'kanji.json'), 'w', encoding='utf-8') as f:
    json.dump(lv, f, ensure_ascii=False, separators=(',', ':'))
print(len(entries), 'entries', len(lv), 'kanji')

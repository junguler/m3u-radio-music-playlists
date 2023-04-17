#!/bin/bash

# cd in to the folder, duh

# remove old cruddy everything files
rm ./---everything-full.m3u ./---everything-lite.m3u ./---randomized.m3u ./---sorted.m3u

# create everything-full file by copying everything except duplicates
cat $( ls -v ) | awk '!seen[$0]++' > ./---everything-full.m3u

# read the full file and remove all extra stuff, we just need the links
cat ./---everything-full.m3u | sed -n '/^#/!p' > ./---everything-lite.m3u

# shuffle the lite file
cat ./---everything-lite.m3u | shuf > ./---randomized.m3u

# sort the lite file
cat ./---everything-lite.m3u | sort > ./---sorted.m3u

#!/bin/bash

# cd in to the folder, duh

# remove old cruddy everything files
rm everything-full.m3u everything-lite.m3u randomized.m3u sorted.m3u

# insert filenames as playlist title and put them in a big file with duplicates
for i in $(ls -v) ; do echo '#PLAYLIST: '$i | cat - $i | sed 's/#EXTM3U//g' | awk NF >> everything-full.txt ; done

# add #EXTM3U to the first line and change the text file to a m3u file format
cat everything-full.txt | awk '!seen[$0]++' | sed '1s/^/#EXTM3U\n/' > everything-full.m3u

# read the full file and remove all extra stuff, we just need the links
cat everything-full.m3u | sed -n '/^#/!p' > everything-lite.m3u

# shuffle the lite file
cat everything-lite.m3u | shuf > randomized.m3u

# sort the lite file
cat everything-lite.m3u | sort > sorted.m3u

# for everything-repo streams
# copy all of the everything-full files to a folder and change their names to avoid substitution
for i in *.m3u ; do cat $i >> every.txt ; done

# remove duplicates
cat every.txt | awk '!seen[$0]++' > every.m3u

# remove stream info
cat every.m3u | sed -n '/^#/!p' | sort > lite.m3u
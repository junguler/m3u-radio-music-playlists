#!/bin/bash

# get a list of genres
curl -s  http://dir.xiph.org/genres | htmlq .list-group-item -a href | grep "/genres/" | awk -F '/' '{print $3}' | sort | uniq | awk NF >> genres.txt

# get a list of genres that have more than one pages, the cursor is needed for scraping further pages
for i in $(cat genres.txt) ; do for j in $((1000 + RANDOM % 9000)) ; do curl -s http://dir.xiph.org/genres/$i | grep ">Next<" | awk -F '"' '{print $4}' | awk 'length>4' >> $(printf "%s_+_%s\n" "$(echo $j)" "$(echo $i)").txt ; done ; done
find . -type f -empty -delete

# find all of the cursors for each genres that have them
for j in {1..20} ; do for i in *.txt ; do curl -s http://dir.xiph.org/genres/$(echo $i | awk -F '+_' '{print $2}' | sed 's|.txt||g')$(cat $i | tail -n 1) | grep ">Next<" | awk -F '"' '{print $4}' | awk 'length>4' >> $i ; done ; done

# scarpe the first pages of each genres
for i in $(cat genres.txt) ; do curl -s http://dir.xiph.org/genres/$i > mep1 ; paste -d '\n' <(cat mep1 | htmlq .shadow-sm h5 -t | awk NF | awk '{print "#EXTINF:-1,"$0}') <(cat mep1 | htmlq .d-inline-block -a href a | awk NF) >> AA-$(echo $i | tr '[:upper:]' '[:lower:]').txt ; echo $i ; done
find . -type f -empty -delete

# scrape the rest of the pages
for i in *_+_*.txt ; do for j in $(cat $i) ; do curl -s http://dir.xiph.org/genres/$(echo $i | awk -F '+_' '{print $2}' | sed 's|.txt||g')$j > mep1 ; paste -d '\n' <(cat mep1 | htmlq .shadow-sm h5 -t | awk NF | awk '{print "#EXTINF:-1,"$0}') <(cat mep1 | htmlq .d-inline-block -a href a | awk NF) >> AA-$(echo $i | awk -F '+_' '{print $2}' | sed 's|.txt||g' | tr '[:upper:]' '[:lower:]').txt ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
#!/bin/bash

# get a list of everything
curl -s http://myradiobox.com/ | htmlq a | head -n 153 | tail -n +40 | sed 's|class="danger p-a" ||g' | sed 's|<a href="/||g' | sed 's|">|-|g' | sed 's|</a>||g' | sed 's| |_|g' > list.txt

# get the links to everything
for i in $(cat list.txt) ; do curl -s http://myradiobox.com/$(echo $i | awk -F '-' '{print $1}')/genre | htmlq -a href a | grep '/genre/' | sort | uniq | sed 's| |%20|g' > A-$(echo $i | awk -F '-' '{print $2}').txt ; done

# make links unique
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s http://myradiobox.com$j | htmlq -a href a | grep '/radio/' | uniq >> B-$(echo $j | sed 's|/|_|g').txt ; echo -e "$i - $j" ; done ; done

# make filenames proper for further operations
for i in *.txt ; do mv $i $(echo $i | sed 's|B-_||g') ; done

# remove old un-needed files 
rm B-*.txt list.txt

# scrape links from every page of every genre/country
for i in *.txt ; do for j in {1..100} ; do curl -s http://myradiobox.com/"$(echo $i | sed -e 's|_|/|g' -e 's|.txt||g')?page="$j | htmlq -a href a | grep '/radio/' | uniq >> $i ; echo -e "$i - $j" ; done ; done

# combine all files with the same prefix
for file in *.txt; do prefix=${file##*_}; prefix=${prefix%.txt}; cat "$file" >> "${prefix}.txt"; done

# scarpe the streams from each page
for i in *.txt ; do for j in $(cat $i) ; do curl -s http://myradiobox.com$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A-$i ; cat mep1 | grep 'data-src=' | head -n 1 | grep -oP 'data-src="\K[^"]+' | sed 's/\;//g' | sed '/^$/d' >> A-$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done

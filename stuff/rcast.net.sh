#!/bin/bash

# find genres, also remove duplicated enteries
for i in /page{1..3145} ; do curl -s https://www.rcast.net/dir/$i | htmlq -a href a | grep -v 'stream.rcast.net' | grep search | awk -F '=' '{print $3}' | awk NF | tr 'A-Z' 'a-z' | sed 's/^[ \t]*//;s/[ \t]*$//' | sed 's| |%20|g' >> genres_dup.txt ; echo $i ; done
cat genres_dup.txt | sort | uniq > genres.txt

# find pages for each category
for i in $(cat genres.txt) ; do for j in {2..100} ; do curl -s https://www.rcast.net/dir/$i/page$j | ./htmlq -a href .text-danger a | uniq >> A-$(echo $i | tr -dc '[:print:]' | tr -d '\\/:*?"<>|').txt ; echo -e "$i - $j" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.rcast.net$j > mep1 ; cat mep1 | htmlq h1 -t | sed 's|Listen to ||g' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep 'URL: "' | head -n 1 | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

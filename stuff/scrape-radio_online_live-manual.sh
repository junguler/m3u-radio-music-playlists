#!/bin/bash

# find genre and country pages
curl https://radioonlinelive.com/genres/ | htmlq -a href a | grep "genres" | sort | uniq | awk -F '/' '{print $5}' | awk NF > genres.txt
curl https://radioonlinelive.com/country/ | htmlq -a href a | grep "category" | sort | awk -F '/' '{print $5}' > countries.txt

# find the stream page for genres and countries
for i in "" page/{2..200}/ ; do for j in $(cat genres.txt) ; do curl -s https://radioonlinelive.com/genres/$j/$i | htmlq -r section -a href a | uniq | grep -v "page\|#\|category\|genre" | awk -F '/' '{print $4"/"$5}' | grep -v "/$" >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" page/{2..200}/ ; do for j in $(cat countries.txt) ; do curl -s https://radioonlinelive.com/category/$j/$i | htmlq -r section -a href a | uniq | grep -v "page\|#\|category\|genre" | awk -F '/' '{print $4"/"$5}' | grep -v "/$" >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radioonlinelive.com/$j/ > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | htmlq source | awk -F '"' {'print $4'} | sed 's/\;//g' | sed '/^$/d'>> A$i ; echo -e "$i - $j" ; done ; done

# remove stream titles that don't have a stream after them
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done

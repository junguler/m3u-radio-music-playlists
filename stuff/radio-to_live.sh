#!/bin/bash

# get a list of genres, languages and countries
curl -s https://radiotolive.com/ | htmlq -a href .card a | grep -v "#" | cut -c25- | sed 's:/\?$:/:g' > list.txt

# get the links to each catagory
for i in "" page/{2..50}/ ; do for j in $(cat list.txt) ; do curl -s https://radiotolive.com/$j$i | htmlq -a href \#gridme-main-wrapper a | grep -v "/page/" | grep -v "genre" | uniq | cut -c25- >> A-$(echo $j | sed 's|/| |g' | awk '{print $2}').txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiotolive.com/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | htmlq audio source | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done

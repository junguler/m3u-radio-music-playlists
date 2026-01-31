#!/bin/bash

# get a list of countries
curl -s https://zinmusic.com/sitemap.xml | htmlq loc -t | sort | uniq | grep -v '/radio/\|/blog/\|/continet/\|add\|map' | awk -F '/' '{print $4"/"$5}' | tail -n +2 > countries.txt

# scrape station names and ids from each country pages
for i in "" /{2..25} ; do for j in $(cat countries.txt) ; do curl -s https://zinmusic.com/$j$i | htmlq -a href a | grep '/radio/' | grep '//' | awk '!seen[$0]++' | cut -d '/' -f5- >> A-$(echo $j | sed 's|/|___|g').txt ; echo -e "$j - $i" ; done ; done

# scrape everything and create additional genres playlist from tags (i did not use this version of the script but the option is there)
# for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://zinmusic.com/radio/$j > mep1 ; T=$(cat mep1 | htmlq h1 -t | awk NF | sed 's/^[[:space:]]*//') ; S=$(cat mep1 | htmlq source -a src | sed 's/\;//g' | sed '/^$/d') ; echo "#EXTINF:-1,$T" >> A$i ; echo "$S" >> A$i ; for g in $(cat mep1 | htmlq 'li:nth-child(8)>span' -t | awk NF | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/ /_/g;s|/||g') ; do echo "#EXTINF:-1,$T" >> "AA-$g.txt" ; echo "$S" >> "AA-$g.txt" ; done ; echo -e "$i - $j" ; done ; done

# alternate way of scraping country files only
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://zinmusic.com/radio/$j > mep1 ; T=$(cat mep1 | htmlq h1 -t | awk NF | sed 's/^[[:space:]]*//') ; S=$(cat mep1 | htmlq source -a src | sed 's/\;//g' | sed '/^$/d') ; echo "#EXTINF:-1,$T" >> A$i ; echo "$S" >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert files to m3u extension
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA and double extensions from files
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
